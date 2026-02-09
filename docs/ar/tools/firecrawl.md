---
summary: "الاستعانة بـ Firecrawl كخيار احتياطي لـ web_fetch (مضاد للروبوتات + استخراج مُخزَّن مؤقتًا)"
read_when:
  - تريد استخراج الويب المدعوم بـ Firecrawl
  - تحتاج إلى مفتاح API لـ Firecrawl
  - تريد استخراجًا مضادًا للروبوتات لـ web_fetch
title: "Firecrawl"
---

# Firecrawl

يمكن لـ OpenClaw استخدام **Firecrawl** كمستخرج احتياطي لـ `web_fetch`. وهي خدمة مستضافة
لاستخراج المحتوى تدعم تجاوز قيود الروبوتات والتخزين المؤقت، ما يساعد
مع المواقع كثيفة JavaScript أو الصفحات التي تحظر جلب HTTP العادي.

## الحصول على مفتاح API

1. أنشئ حسابًا في Firecrawl وأنشئ مفتاح API.
2. خزّنه في التهيئة أو اضبط `FIRECRAWL_API_KEY` في بيئة Gateway.

## تهيئة Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

ملاحظات:

- القيمة الافتراضية لـ `firecrawl.enabled` هي true عند وجود مفتاح API.
- يتحكم `maxAgeMs` في مدى قِدم النتائج المُخزَّنة مؤقتًا (بالمللي ثانية). القيمة الافتراضية هي يومان.

## التخفي / تجاوز الروبوتات

يوفّر Firecrawl معامل **وضع الوكيل** لتجاوز الروبوتات (`basic`، `stealth`، أو `auto`).
يستخدم OpenClaw دائمًا `proxy: "auto"` بالإضافة إلى `storeInCache: true` لطلبات Firecrawl.
إذا تم إغفال الوكيل، فسيستخدم Firecrawl افتراضيًا `auto`. يقوم `auto` بإعادة المحاولة باستخدام وكلاء التخفي إذا فشلت المحاولة الأساسية، وقد يستهلك ذلك أرصدة أكثر
مقارنة بالاستخراج الأساسي فقط.

## كيف يستخدم `web_fetch` Firecrawl

ترتيب الاستخراج في `web_fetch`:

1. Readability (محلي)
2. Firecrawl (إذا تمّت تهيئته)
3. تنظيف HTML الأساسي (الملاذ الأخير)

انظر [أدوات الويب](/tools/web) للاطلاع على الإعداد الكامل لأدوات الويب.
