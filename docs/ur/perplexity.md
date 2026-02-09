---
summary: "ویب سرچ کے لیے Perplexity Sonar کی سیٹ اپ"
read_when:
  - آپ ویب سرچ کے لیے Perplexity Sonar استعمال کرنا چاہتے ہیں
  - آپ کو PERPLEXITY_API_KEY یا OpenRouter سیٹ اپ درکار ہے
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw can use Perplexity Sonar for the `web_search` tool. You can connect
through Perplexity’s direct API or via OpenRouter.

## API کے اختیارات

### Perplexity (براہِ راست)

- بیس URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- ماحولیاتی متغیر: `PERPLEXITY_API_KEY`

### OpenRouter (متبادل)

- بیس URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- ماحولیاتی متغیر: `OPENROUTER_API_KEY`
- پری پیڈ/کرپٹو کریڈٹس کی معاونت کرتا ہے۔

## کنفیگ کی مثال

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

## Brave سے سوئچ کرنا

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

اگر `PERPLEXITY_API_KEY` اور `OPENROUTER_API_KEY` دونوں سیٹ ہوں، تو ابہام دور کرنے کے لیے `tools.web.search.perplexity.baseUrl` (یا `tools.web.search.perplexity.apiKey`) سیٹ کریں۔

اگر کوئی بیس URL سیٹ نہ ہو، تو OpenClaw API کلید کے ماخذ کی بنیاد پر ڈیفالٹ منتخب کرتا ہے:

- `PERPLEXITY_API_KEY` یا `pplx-...` → براہِ راست Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` یا `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- نامعلوم کلید فارمیٹس → OpenRouter (محفوظ فال بیک)

## ماڈلز

- `perplexity/sonar` — ویب سرچ کے ساتھ تیز سوال و جواب
- `perplexity/sonar-pro` (ڈیفالٹ) — کثیر مرحلہ استدلال + ویب سرچ
- `perplexity/sonar-reasoning-pro` — گہری تحقیق

مکمل web_search کنفیگریشن کے لیے [Web tools](/tools/web) دیکھیں۔
