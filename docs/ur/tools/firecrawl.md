---
summary: "web_fetch کے لیے Firecrawl فال بیک (اینٹی بوٹ + کیشڈ استخراج)"
read_when:
  - آپ Firecrawl پر مبنی ویب استخراج چاہتے ہیں
  - آپ کو Firecrawl API کلید درکار ہے
  - آپ web_fetch کے لیے اینٹی بوٹ استخراج چاہتے ہیں
title: "Firecrawl"
---

# Firecrawl

OpenClaw can use **Firecrawl** as a fallback extractor for `web_fetch`. It is a hosted
content extraction service that supports bot circumvention and caching, which helps
with JS-heavy sites or pages that block plain HTTP fetches.

## API کلید حاصل کریں

1. Firecrawl اکاؤنٹ بنائیں اور ایک API کلید تیار کریں۔
2. اسے کنفیگ میں محفوظ کریں یا گیٹ وے ماحول میں `FIRECRAWL_API_KEY` سیٹ کریں۔

## Firecrawl کنفیگر کریں

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

نوٹس:

- جب API کلید موجود ہو تو `firecrawl.enabled` بطورِ طے شدہ true ہوتا ہے۔
- `maxAgeMs` controls how old cached results can be (ms). Default is 2 days.

## اسٹیلتھ / بوٹ سے بچاؤ

Firecrawl exposes a **proxy mode** parameter for bot circumvention (`basic`, `stealth`, or `auto`).
OpenClaw always uses `proxy: "auto"` plus `storeInCache: true` for Firecrawl requests.
If proxy is omitted, Firecrawl defaults to `auto`. `auto` retries with stealth proxies if a basic attempt fails, which may use more credits
than basic-only scraping.

## `web_fetch` Firecrawl کیسے استعمال کرتا ہے

`web_fetch` استخراج کی ترتیب:

1. Readability (لوکل)
2. Firecrawl (اگر کنفیگر کیا گیا ہو)
3. بنیادی HTML صفائی (آخری فال بیک)

مکمل ویب ٹول سیٹ اپ کے لیے [Web tools](/tools/web) دیکھیں۔
