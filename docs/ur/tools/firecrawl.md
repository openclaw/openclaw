---
summary: "web_fetch کے لیے Firecrawl فال بیک (اینٹی بوٹ + کیشڈ استخراج)"
read_when:
  - آپ Firecrawl پر مبنی ویب استخراج چاہتے ہیں
  - آپ کو Firecrawl API کلید درکار ہے
  - آپ web_fetch کے لیے اینٹی بوٹ استخراج چاہتے ہیں
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:42Z
---

# Firecrawl

OpenClaw، `web_fetch` کے لیے **Firecrawl** کو فال بیک extractor کے طور پر استعمال کر سکتا ہے۔ یہ ایک ہوسٹڈ
مواد استخراج سروس ہے جو بوٹ سے بچاؤ اور کیشنگ کی حمایت کرتی ہے، جو
JS-بھاری سائٹس یا ان صفحات کے لیے مفید ہے جو سادہ HTTP fetches کو بلاک کرتے ہیں۔

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
- `maxAgeMs` یہ کنٹرول کرتا ہے کہ کیشڈ نتائج کتنے پرانے ہو سکتے ہیں (ms)۔ بطورِ طے شدہ 2 دن۔

## اسٹیلتھ / بوٹ سے بچاؤ

Firecrawl بوٹ سے بچاؤ کے لیے **proxy mode** پیرامیٹر فراہم کرتا ہے (`basic`, `stealth`, یا `auto`)۔
OpenClaw ہمیشہ Firecrawl درخواستوں کے لیے `proxy: "auto"` کے ساتھ `storeInCache: true` استعمال کرتا ہے۔
اگر proxy شامل نہ ہو تو Firecrawl بطورِ طے شدہ `auto` استعمال کرتا ہے۔ اگر بنیادی کوشش ناکام ہو جائے تو `auto` اسٹیلتھ پروکسیز کے ساتھ دوبارہ کوشش کرتا ہے، جس میں
صرف بنیادی اسکریپنگ کے مقابلے میں زیادہ کریڈٹس استعمال ہو سکتے ہیں۔

## `web_fetch` Firecrawl کیسے استعمال کرتا ہے

`web_fetch` استخراج کی ترتیب:

1. Readability (لوکل)
2. Firecrawl (اگر کنفیگر کیا گیا ہو)
3. بنیادی HTML صفائی (آخری فال بیک)

مکمل ویب ٹول سیٹ اپ کے لیے [Web tools](/tools/web) دیکھیں۔
