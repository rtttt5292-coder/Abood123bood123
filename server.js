/**
 * ==========================================================================
 * VideoSearch Pro - Backend بديل عن YouTube Data API
 * ==========================================================================
 * يستخدم مكتبة youtubei.js (LuanRT/YouTube.js) للتواصل مباشرة مع InnerTube
 * الواجهة الداخلية التي يستخدمها يوتيوب نفسه، فلا حاجة لمفتاح API رسمي
 * ولا حصة استخدام يومية (quota) كما هو الحال مع Google API.
 *
 * ⚠️ ملاحظة مهمة:
 * هذه المكتبة تعتمد على هندسة عكسية (reverse-engineering) لواجهة يوتيوب
 * غير الموثّقة رسميًا، لذلك قد تتوقف بعض الوظائف عن العمل إذا غيّرت
 * يوتيوب طريقة عملها الداخلية. راجع: https://github.com/LuanRT/YouTube.js
 * ==========================================================================
 */

import express from 'express';
import cors from 'cors';
import { Innertube, UniversalCache } from 'youtubei.js';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------------
// خدمة الواجهة الأمامية (index.html) عند الصفحة الرئيسية
// بهذا يعمل رابط Railway نفسه كموقع كامل (واجهة + API) بدون استضافة منفصلة
// ------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ------------------------------------------------------------------------
// تهيئة Innertube مرة واحدة عند تشغيل السيرفر (يُعاد استخدامها لكل الطلبات)
// ------------------------------------------------------------------------
let youtube;
(async () => {
  youtube = await Innertube.create({
    cache: new UniversalCache(false), // بدون تخزين مؤقت على القرص (بسيط للتجربة)
    generate_session_locally: true
    // ملاحظة: إذا استمر ظهور "Failed to extract signature decipher algorithm"
    // بعد تحديث الحزمة لآخر إصدار، جرّب إضافة player_id معروف هنا، مثل:
    // player_id: '2b83d2e0'
    // هذا حل مؤقت غير مضمون - راجع:
    // https://github.com/LuanRT/YouTube.js/issues/1043
  });
  console.log('✅ Innertube جاهز - السيرفر يستمع على المنفذ', PORT);
})();

// ذاكرة مؤقتة لحفظ كائنات البحث للتنقل بين الصفحات (pageToken)
// ملاحظة: تُفرَّغ عند إعادة تشغيل السيرفر - كافية لموقع شخصي/تجريبي
const searchCache = new Map();

/**
 * تحويل ثوانٍ إلى صيغة ISO 8601 (نفس صيغة Google) حتى تبقى دوال
 * الواجهة الأمامية (parseDuration) تعمل دون أي تعديل تقريبًا
 */
function secondsToIso8601(totalSeconds) {
  const s = Math.floor(totalSeconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let iso = 'PT';
  if (h) iso += `${h}H`;
  if (m) iso += `${m}M`;
  iso += `${sec}S`;
  return iso;
}

/* ==========================================================================
   GET /api/search?q=كلمة+البحث&pageToken=اختياري
   يُعيد نفس شكل استجابة Google (items[].id.videoId / items[].snippet ...)
   حتى تعمل دوال renderResults الحالية في index.html دون تعديل يُذكر
========================================================================== */
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    const pageToken = req.query.pageToken;

    if (!query) {
      return res.status(400).json({ error: { message: 'الرجاء إرسال معامل q (نص البحث)' } });
    }

    let searchResult;

    if (pageToken && searchCache.has(pageToken)) {
      // طلب صفحة تالية: استخدم continuation من نتيجة سابقة محفوظة
      const prevSearch = searchCache.get(pageToken);
      searchResult = await prevSearch.getContinuation();
      searchCache.delete(pageToken); // لا حاجة للاحتفاظ بالقديم
    } else {
      // بحث جديد
      searchResult = await youtube.search(query, { type: 'video' });
    }

    const videos = (searchResult.videos || []).filter(v => v.id); // استبعاد عناصر ليست فيديو

    const items = videos.map(v => ({
      id: v.id, // نص مباشر (وليس {videoId}) لأن renderResults في الواجهة يتوقعه هكذا
      snippet: {
        title: v.title?.text || v.title || 'بدون عنوان',
        description: v.description_snippet?.text || v.description || '',
        channelTitle: v.author?.name || 'غير معروف',
        // published نص نسبي مثل "3 years ago" وليس تاريخ ISO -
        // دالة formatDate في الواجهة الأمامية مُعدَّلة لعرضه كما هو
        publishedAt: v.published?.text || v.metadata?.published || '',
        thumbnails: {
          default: { url: v.thumbnails?.[0]?.url || v.best_thumbnail?.url || '' },
          medium:  { url: v.thumbnails?.[v.thumbnails.length - 1]?.url || v.best_thumbnail?.url || '' }
        }
      },
      contentDetails: {
        // ثوانٍ محوّلة لصيغة ISO حتى تعمل parseDuration كما هي
        duration: secondsToIso8601(v.duration?.seconds)
      },
      statistics: {
        // إزالة أي فواصل/نصوص غير رقمية حتى تعمل formatViews
        viewCount: (v.view_count?.text || v.short_view_count?.text || '0').replace(/[^\d]/g, '') || '0'
      }
    }));

    // حفظ نتيجة البحث الحالية لإتاحة "الصفحة التالية" لاحقًا
    const nextToken = randomUUID();
    if (searchResult.has_continuation) {
      searchCache.set(nextToken, searchResult);
    }

    res.json({
      items,
      nextPageToken: searchResult.has_continuation ? nextToken : '',
      pageInfo: { totalResults: searchResult.estimated_results || items.length }
    });

  } catch (err) {
    console.error('خطأ في /api/search:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/* ==========================================================================
   GET /api/videos?id=videoId
   يُعيد تفاصيل فيديو واحد بنفس شكل استجابة Google videos.list
========================================================================== */
app.get('/api/videos', async (req, res) => {
  try {
    const videoId = req.query.id;
    if (!videoId) {
      return res.status(400).json({ error: { message: 'الرجاء إرسال معامل id' } });
    }

    const info = await youtube.getInfo(videoId);
    const basic = info.basic_info;

    const item = {
      id: videoId,
      snippet: {
        title: basic.title || 'بدون عنوان',
        description: basic.short_description || '',
        channelTitle: basic.channel?.name || basic.author || 'غير معروف',
        publishedAt: basic.publish_date || basic.upload_date || '',
        thumbnails: {
          maxres: { url: basic.thumbnail?.[basic.thumbnail.length - 1]?.url || '' },
          high:   { url: basic.thumbnail?.[0]?.url || '' },
          medium: { url: basic.thumbnail?.[0]?.url || '' }
        }
      },
      contentDetails: {
        duration: secondsToIso8601(basic.duration)
      },
      statistics: {
        viewCount: String(basic.view_count || 0),
        likeCount: String(basic.like_count || 0)
      }
    };

    res.json({ items: [item] });

  } catch (err) {
    console.error('خطأ في /api/videos:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/* ==========================================================================
   GET /api/download?videoId=xxx&format=mp4|mp3
   يبثّ الملف مباشرة إلى المتصفح (لا يُعيد رابطًا، بل يبثّ البيانات نفسها)
   لأن روابط ستريم يوتيوب الخام تنتهي صلاحيتها بسرعة وتتطلب تريّث/تواقيع
========================================================================== */
app.get('/api/download', async (req, res) => {
  const { videoId, format } = req.query;

  if (!videoId || !format) {
    return res.status(400).json({ error: { message: 'الرجاء إرسال videoId و format' } });
  }

  try {
    const info = await youtube.getInfo(videoId);
    const safeTitle = (info.basic_info.title || 'video').replace(/[^\w\u0600-\u06FF\- ]/g, '').slice(0, 80);

    if (format === 'mp3') {
      // ملاحظة: هذا يُنزّل أفضل مسار صوتي متاح (عادة بصيغة m4a/webm)
      // وليس تحويلًا حقيقيًا إلى mp3. للتحويل الحقيقي يلزم تمرير الناتج
      // عبر ffmpeg على السيرفر (راجع التعليق أسفل الملف).
      const stream = await youtube.download(videoId, {
        type: 'audio',
        quality: 'best',
        format: 'mp4'
      });
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.m4a"`);
      res.setHeader('Content-Type', 'audio/mp4');
      for await (const chunk of stream) res.write(chunk);
      res.end();

    } else {
      const stream = await youtube.download(videoId, {
        type: 'video+audio',
        quality: 'best',
        format: 'mp4'
      });
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');
      for await (const chunk of stream) res.write(chunk);
      res.end();
    }

  } catch (err) {
    console.error('خطأ في /api/download:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على http://localhost:${PORT}`);
});

/* ==========================================================================
   ملاحظة حول تحويل حقيقي إلى MP3:
   إذا أردت ملف mp3 حقيقيًا (وليس m4a)، ثبّت ffmpeg على جهازك، ثم استبدل
   جزء "for await (const chunk of stream) res.write(chunk)" الخاص بـ mp3
   بتمرير الـ stream عبر fluent-ffmpeg مع الخيار .toFormat('mp3') قبل
   إرساله إلى res. هذا يتطلب: npm install fluent-ffmpeg
========================================================================== */
