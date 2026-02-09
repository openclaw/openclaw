---
summary: "إعداد واجهة برمجة تطبيقات Brave Search لاستخدام web_search"
read_when:
  - تريد استخدام Brave Search لأداة web_search
  - تحتاج إلى BRAVE_API_KEY أو تفاصيل الخطة
title: "Brave Search"
---

# واجهة برمجة تطبيقات Brave Search

يستخدم OpenClaw خدمة Brave Search باعتبارها الموفّر الافتراضي لـ `web_search`.

## الحصول على مفتاح واجهة برمجة التطبيقات

1. أنشئ حساب واجهة برمجة تطبيقات Brave Search على الرابط: [https://brave.com/search/api/](https://brave.com/search/api/)
2. من لوحة التحكم، اختر خطة **Data for Search** وقم بإنشاء مفتاح واجهة برمجة التطبيقات.
3. خزّن المفتاح في التهيئة (موصى به) أو عيّن `BRAVE_API_KEY` في بيئة Gateway.

## مثال على التهيئة

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## ملاحظات

- خطة Data for AI **غير** متوافقة مع `web_search`.
- توفّر Brave فئة مجانية إلى جانب خطط مدفوعة؛ راجع بوابة واجهة برمجة تطبيقات Brave للاطلاع على الحدود الحالية.

انظر [أدوات الويب](/tools/web) للاطلاع على التهيئة الكاملة لـ web_search.
