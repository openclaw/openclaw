---
summary: "ویب سرچ + فِچ اوزار (Brave Search API، Perplexity direct/OpenRouter)"
read_when:
  - آپ web_search یا web_fetch کو فعال کرنا چاہتے ہیں
  - آپ کو Brave Search API کلید کا سیٹ اپ درکار ہے
  - آپ ویب سرچ کے لیے Perplexity Sonar استعمال کرنا چاہتے ہیں
title: "ویب اوزار"
---

# ویب اوزار

OpenClaw دو ہلکے پھلکے ویب اوزار فراہم کرتا ہے:

- `web_search` — Brave Search API (بطورِ طے شدہ) یا Perplexity Sonar (براہِ راست یا OpenRouter کے ذریعے) کے ذریعے ویب تلاش۔
- `web_fetch` — HTTP فِچ + قابلِ مطالعہ اخراج (HTML → markdown/text)۔

یہ **browser automation** نہیں ہیں۔ JS-heavy سائٹس یا لاگ اِنز کے لیے، استعمال کریں
[Browser tool](/tools/browser)۔

## یہ کیسے کام کرتا ہے

- `web_search` آپ کے کنفیگر کردہ فراہم کنندہ کو کال کرتا ہے اور نتائج واپس کرتا ہے۔
  - **Brave** (بطورِ طے شدہ): ساختہ نتائج (عنوان، URL، خلاصہ) واپس کرتا ہے۔
  - **Perplexity**: حقیقی وقت کی ویب سرچ سے حوالہ جات کے ساتھ AI-مرکب جوابات واپس کرتا ہے۔
- نتائج کو کوئری کے مطابق 15 منٹ کے لیے کیش کیا جاتا ہے (قابلِ کنفیگریشن)۔
- `web_fetch` ایک سادہ HTTP GET کرتا ہے اور قابلِ مطالعہ مواد نکالتا ہے
  (HTML → markdown/text)۔ یہ JavaScript کو **execute نہیں** کرتا۔
- `web_fetch` بطورِ طے شدہ فعال ہے (جب تک صراحتاً غیرفعال نہ کیا جائے)۔

## سرچ فراہم کنندہ کا انتخاب

| Provider                               | فوائد                                | نقصانات                                 | API Key                                      |
| -------------------------------------- | ------------------------------------ | --------------------------------------- | -------------------------------------------- |
| **Brave** (default) | تیز، ساختہ نتائج، مفت درجۂ آغاز      | روایتی سرچ نتائج                        | `BRAVE_API_KEY`                              |
| **Perplexity**                         | AI-مرکب جوابات، حوالہ جات، حقیقی وقت | Perplexity یا OpenRouter تک رسائی درکار | `OPENROUTER_API_KEY` یا `PERPLEXITY_API_KEY` |

فراہم کنندہ کی مخصوص تفصیلات کے لیے [Brave Search setup](/brave-search) اور [Perplexity Sonar](/perplexity) دیکھیں۔

کنفیگ میں فراہم کنندہ سیٹ کریں:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

مثال: Perplexity Sonar (براہِ راست API) پر سوئچ کریں:

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

## Brave API کلید حاصل کرنا

1. [https://brave.com/search/api/](https://brave.com/search/api/) پر Brave Search API اکاؤنٹ بنائیں
2. ڈیش بورڈ میں **Data for Search** پلان منتخب کریں (“Data for AI” نہیں) اور API کلید بنائیں۔
3. کنفیگ میں کلید محفوظ کرنے کے لیے `openclaw configure --section web` چلائیں (سفارش کردہ)، یا اپنے ماحول میں `BRAVE_API_KEY` سیٹ کریں۔

Brave مفت درجۂ آغاز اور ادائیگی والے پلان فراہم کرتا ہے؛ موجودہ حدود اور قیمتوں کے لیے
Brave API پورٹل دیکھیں۔

### کلید کہاں سیٹ کریں (سفارش کردہ)

**سفارش کردہ:** `openclaw configure --section web` چلائیں۔ یہ کلید کو
`~/.openclaw/openclaw.json` میں `tools.web.search.apiKey` کے تحت محفوظ کرتا ہے۔

**ماحولیاتی متبادل:** گیٹ وے پروسس کے ماحول میں `BRAVE_API_KEY` سیٹ کریں۔ گیٹ وے انسٹال کے لیے، اسے `~/.openclaw/.env` میں رکھیں (یا اپنے سروس ماحول میں)۔ دیکھیں [Env vars](/help/faq#how-does-openclaw-load-environment-variables)۔

## Perplexity کا استعمال (براہِ راست یا OpenRouter کے ذریعے)

Perplexity Sonar ماڈلز میں بلٹ اِن ویب سرچ صلاحیتیں ہوتی ہیں اور یہ حوالہ جات کے ساتھ AI-synthesized جوابات واپس کرتے ہیں۔ آپ انہیں OpenRouter کے ذریعے استعمال کر سکتے ہیں (کریڈٹ کارڈ درکار نہیں — crypto/prepaid سپورٹ کرتا ہے)۔

### OpenRouter API کلید حاصل کرنا

1. [https://openrouter.ai/](https://openrouter.ai/) پر اکاؤنٹ بنائیں
2. کریڈٹس شامل کریں (کرپٹو، پری پیڈ، یا کریڈٹ کارڈ سپورٹ)
3. اکاؤنٹ سیٹنگز میں API کلید بنائیں

### Perplexity سرچ سیٹ اپ کرنا

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**ماحولیاتی متبادل:** گیٹ وے ماحول میں `OPENROUTER_API_KEY` یا `PERPLEXITY_API_KEY` سیٹ کریں۔ گیٹ وے انسٹال کے لیے، اسے `~/.openclaw/.env` میں رکھیں۔

اگر کوئی بیس URL سیٹ نہ ہو تو، OpenClaw API کلید کے ماخذ کی بنیاد پر ایک بطورِ طے شدہ انتخاب کرتا ہے:

- `PERPLEXITY_API_KEY` یا `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` یا `sk-or-...` → `https://openrouter.ai/api/v1`
- نامعلوم کلید فارمیٹس → OpenRouter (محفوظ فال بیک)

### دستیاب Perplexity ماڈلز

| Model                                               | وضاحت                                       | بہترین استعمال |
| --------------------------------------------------- | ------------------------------------------- | -------------- |
| `perplexity/sonar`                                  | ویب سرچ کے ساتھ تیز Q&A | فوری تلاشیں    |
| `perplexity/sonar-pro` (default) | ویب سرچ کے ساتھ کثیر مرحلہ استدلال          | پیچیدہ سوالات  |
| `perplexity/sonar-reasoning-pro`                    | چین آف تھاٹ تجزیہ                           | گہری تحقیق     |

## web_search

اپنے کنفیگر کردہ فراہم کنندہ کے ذریعے ویب تلاش کریں۔

### ضروریات

- `tools.web.search.enabled` کو `false` نہیں ہونا چاہیے (بطورِ طے شدہ: فعال)
- منتخب فراہم کنندہ کے لیے API کلید:
  - **Brave**: `BRAVE_API_KEY` یا `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`، `PERPLEXITY_API_KEY`، یا `tools.web.search.perplexity.apiKey`

### کنفیگ

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### اوزار کے پیرامیٹرز

- `query` (لازم)
- `count` (1–10؛ بطورِ طے شدہ کنفیگ سے)
- `country` (اختیاری): علاقائی نتائج کے لیے 2 حرفی کنٹری کوڈ (مثلاً "DE", "US", "ALL")۔ اگر چھوڑ دیا جائے تو Brave اپنا ڈیفالٹ ریجن منتخب کرتا ہے۔
- `search_lang` (اختیاری): سرچ نتائج کے لیے ISO زبان کوڈ (مثلاً "de"، "en"، "fr")
- `ui_lang` (اختیاری): UI عناصر کے لیے ISO زبان کوڈ
- `freshness` (اختیاری، صرف Brave): دریافت کے وقت کے مطابق فلٹر (`pd`، `pw`، `pm`، `py`، یا `YYYY-MM-DDtoYYYY-MM-DD`)

**مثالیں:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

ایک URL فِچ کریں اور قابلِ مطالعہ مواد نکالیں۔

### web_fetch ضروریات

- `tools.web.fetch.enabled` کو `false` نہیں ہونا چاہیے (بطورِ طے شدہ: فعال)
- اختیاری Firecrawl فال بیک: `tools.web.fetch.firecrawl.apiKey` یا `FIRECRAWL_API_KEY` سیٹ کریں۔

### web_fetch کنفیگ

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch اوزار کے پیرامیٹرز

- `url` (لازم، صرف http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (طویل صفحات کو مختصر کریں)

نوٹس:

- `web_fetch` پہلے Readability (main-content extraction) استعمال کرتا ہے، پھر Firecrawl (اگر کنفیگر ہو)۔ اگر دونوں ناکام ہوں تو ٹول ایک ایرر واپس کرتا ہے۔
- Firecrawl درخواستیں bot-circumvention موڈ استعمال کرتی ہیں اور بطورِ طے شدہ نتائج کو کیش کرتی ہیں۔
- `web_fetch` بطورِ طے شدہ Chrome جیسا User-Agent اور `Accept-Language` بھیجتا ہے؛ ضرورت ہو تو `userAgent` اووررائیڈ کریں۔
- `web_fetch` نجی/اندرونی ہوسٹ ناموں کو بلاک کرتا ہے اور ری ڈائریکٹس دوبارہ چیک کرتا ہے (حد `maxRedirects` کے ساتھ)۔
- `maxChars` کو `tools.web.fetch.maxCharsCap` تک محدود کیا جاتا ہے۔
- `web_fetch` بہترین کوشش پر مبنی اخراج ہے؛ کچھ سائٹس کے لیے براؤزر اوزار درکار ہوگا۔
- کلید کے سیٹ اپ اور سروس کی تفصیلات کے لیے [Firecrawl](/tools/firecrawl) دیکھیں۔
- بار بار فِچ کم کرنے کے لیے جوابات کیش کیے جاتے ہیں (بطورِ طے شدہ 15 منٹ)۔
- اگر آپ tool profiles/allowlists استعمال کرتے ہیں تو `web_search`/`web_fetch` یا `group:web` شامل کریں۔
- اگر Brave کلید موجود نہ ہو تو `web_search` دستاویزات کے لنک کے ساتھ مختصر سیٹ اپ اشارہ واپس کرتا ہے۔
