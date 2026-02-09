---
summary: "إعداد Perplexity Sonar لـ web_search"
read_when:
  - تريد استخدام Perplexity Sonar للبحث على الويب
  - تحتاج إلى PERPLEXITY_API_KEY أو إعداد OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

يمكن لـ OpenClaw استخدام Perplexity Sonar لأداة `web_search`. يمكنك الاتصال
عبر واجهة برمجة التطبيقات المباشرة لـ Perplexity أو عبر OpenRouter.

## خيارات واجهة برمجة التطبيقات

### Perplexity (مباشر)

- عنوان URL الأساسي: [https://api.perplexity.ai](https://api.perplexity.ai)
- متغير البيئة: `PERPLEXITY_API_KEY`

### OpenRouter (بديل)

- عنوان URL الأساسي: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- متغير البيئة: `OPENROUTER_API_KEY`
- يدعم أرصدة مدفوعة مسبقًا/بالعملات المشفّرة.

## مثال على التهيئة

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## التبديل من Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

إذا تم تعيين كلٍّ من `PERPLEXITY_API_KEY` و `OPENROUTER_API_KEY`، فاضبط
`tools.web.search.perplexity.baseUrl` (أو `tools.web.search.perplexity.apiKey`)
لإزالة الالتباس.

إذا لم يتم تعيين عنوان URL أساسي، يختار OpenClaw قيمة افتراضية بناءً على مصدر مفتاح واجهة برمجة التطبيقات:

- `PERPLEXITY_API_KEY` أو `pplx-...` → Perplexity مباشر (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` أو `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- تنسيقات مفاتيح غير معروفة → OpenRouter (احتياطي آمن)

## النماذج

- `perplexity/sonar` — أسئلة وأجوبة سريعة مع البحث على الويب
- `perplexity/sonar-pro` (افتراضي) — استدلال متعدد الخطوات + البحث على الويب
- `perplexity/sonar-reasoning-pro` — بحث معمّق

انظر [أدوات الويب](/tools/web) للاطلاع على التهيئة الكاملة لـ web_search.
