---
summary: "web_search کے لیے Brave Search API کا سیٹ اپ"
read_when:
  - آپ web_search کے لیے Brave Search استعمال کرنا چاہتے ہیں
  - آپ کو BRAVE_API_KEY یا پلان کی تفصیلات درکار ہیں
title: "Brave Search"
---

# Brave Search API

OpenClaw، `web_search` کے لیے بطورِ طے شدہ فراہم کنندہ Brave Search استعمال کرتا ہے۔

## API کلید حاصل کریں

1. [https://brave.com/search/api/](https://brave.com/search/api/) پر Brave Search API اکاؤنٹ بنائیں
2. ڈیش بورڈ میں **Data for Search** پلان منتخب کریں اور ایک API کلید تیار کریں۔
3. کلید کو کنفیگ میں محفوظ کریں (سفارش کردہ) یا Gateway ماحول میں `BRAVE_API_KEY` سیٹ کریں۔

## کنفیگ کی مثال

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

## نوٹس

- Data for AI پلان `web_search` کے ساتھ **مطابقت نہیں رکھتا**۔
- Brave مفت درجے کے ساتھ ساتھ بامعاوضہ پلانز بھی فراہم کرتا ہے؛ موجودہ حدود کے لیے Brave API پورٹل دیکھیں۔

web_search کی مکمل کنفیگریشن کے لیے [Web tools](/tools/web) دیکھیں۔
