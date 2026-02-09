---
summary: "أدوات البحث على الويب + الجلب (واجهة برمجة تطبيقات Brave Search، وPerplexity مباشر/OpenRouter)"
read_when:
  - تريد تمكين web_search أو web_fetch
  - تحتاج إلى إعداد مفتاح واجهة برمجة تطبيقات Brave Search
  - تريد استخدام Perplexity Sonar للبحث على الويب
title: "أدوات الويب"
---

# أدوات الويب

يوفّر OpenClaw أداتين خفيفتين للويب:

- `web_search` — البحث في الويب عبر واجهة برمجة تطبيقات Brave Search (افتراضيًا) أو Perplexity Sonar (مباشر أو عبر OpenRouter).
- `web_fetch` — جلب HTTP + استخراج قابل للقراءة (HTML → markdown/text).

هذه **ليست** أتمتة متصفح. للمواقع الثقيلة بـ JS أو التي تتطلب تسجيل دخول، استخدم
[أداة المتصفح](/tools/browser).

## كيف يعمل

- `web_search` يستدعي الموفّر الذي قمت بتهيئته ويعيد النتائج.
  - **Brave** (افتراضي): يعيد نتائج مُهيكلة (العنوان، الرابط، المقتطف).
  - **Perplexity**: يعيد إجابات مُولّدة بالذكاء الاصطناعي مع اقتباسات من بحث ويب آني.
- يتم تخزين النتائج مؤقتًا حسب الاستعلام لمدة 15 دقيقة (قابلة للتهيئة).
- `web_fetch` يجري طلب HTTP GET عاديًا ويستخرج المحتوى القابل للقراءة
  (HTML → markdown/text). وهو **لا** ينفّذ JavaScript.
- `web_fetch` مفعّل افتراضيًا (ما لم يتم تعطيله صراحةً).

## اختيار موفّر البحث

| Provider                               | Pros                                            | السياقات                            | مفتاح API                                    |
| -------------------------------------- | ----------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| **Brave** (افتراضي) | سريع، نتائج مُهيكلة، شريحة مجانية               | نتائج بحث تقليدية                   | `BRAVE_API_KEY`                              |
| **Perplexity**                         | إجابات مُولّدة بالذكاء الاصطناعي، اقتباسات، آني | يتطلب وصول Perplexity أو OpenRouter | `OPENROUTER_API_KEY` أو `PERPLEXITY_API_KEY` |

انظر [إعداد Brave Search](/brave-search) و[Perplexity Sonar](/perplexity) لتفاصيل خاصة بكل موفّر.

قم بتعيين الموفّر في التهيئة:

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

مثال: التبديل إلى Perplexity Sonar (واجهة برمجة مباشرة):

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

## الحصول على مفتاح Brave API

1. أنشئ حساب Brave Search API على [https://brave.com/search/api/](https://brave.com/search/api/)
2. من لوحة التحكم، اختر خطة **Data for Search** (وليس “Data for AI”) وأنشئ مفتاح API.
3. شغّل `openclaw configure --section web` لتخزين المفتاح في التهيئة (موصى به)، أو اضبط `BRAVE_API_KEY` في بيئتك.

يوفّر Brave شريحة مجانية إضافةً إلى خطط مدفوعة؛ راجع بوابة Brave API للاطلاع على
الحدود الحالية والتسعير.

### أين تضبط المفتاح (موصى به)

**موصى به:** شغّل `openclaw configure --section web`. سيخزّن المفتاح في
`~/.openclaw/openclaw.json` تحت `tools.web.search.apiKey`.

**بديل عبر البيئة:** اضبط `BRAVE_API_KEY` في بيئة عملية Gateway. لتثبيت gateway، ضعه في `~/.openclaw/.env` (أو بيئة خدمتك). انظر [متغيرات البيئة](/help/faq#how-does-openclaw-load-environment-variables).

## استخدام Perplexity (مباشر أو عبر OpenRouter)

نماذج Perplexity Sonar تمتلك قدرات بحث ويب مدمجة وتعيد
إجابات مُولّدة بالذكاء الاصطناعي مع اقتباسات. يمكنك استخدامها عبر OpenRouter
(لا يتطلب بطاقة ائتمان — يدعم العملات المشفّرة/الدفع المسبق).

### الحصول على مفتاح OpenRouter API

1. أنشئ حسابًا على [https://openrouter.ai/](https://openrouter.ai/)
2. أضف رصيدًا (يدعم العملات المشفّرة، الدفع المسبق، أو بطاقة ائتمان)
3. أنشئ مفتاح API من إعدادات حسابك

### إعداد بحث Perplexity

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

**بديل عبر البيئة:** اضبط `OPENROUTER_API_KEY` أو `PERPLEXITY_API_KEY` في بيئة Gateway. لتثبيت gateway، ضعه في `~/.openclaw/.env`.

إذا لم يتم تعيين عنوان أساسي، يختار OpenClaw قيمة افتراضية بناءً على مصدر مفتاح API:

- `PERPLEXITY_API_KEY` أو `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` أو `sk-or-...` → `https://openrouter.ai/api/v1`
- صيغ مفاتيح غير معروفة → OpenRouter (احتياط آمن)

### نماذج Perplexity المتاحة

| النموذج                                             | الوصف                            | الأنسب لـ       |
| --------------------------------------------------- | -------------------------------- | --------------- |
| `perplexity/sonar`                                  | أسئلة وأجوبة سريعة مع بحث ويب    | استعلامات سريعة |
| `perplexity/sonar-pro` (افتراضي) | استدلال متعدد الخطوات مع بحث ويب | أسئلة معقّدة    |
| `perplexity/sonar-reasoning-pro`                    | تحليل سلسلة الأفكار              | بحث معمّق       |

## web_search

البحث في الويب باستخدام الموفّر الذي قمت بتهيئته.

### المتطلبات

- يجب ألا يكون `tools.web.search.enabled` مساويًا لـ `false` (الافتراضي: مفعّل)
- مفتاح API للموفّر الذي اخترته:
  - **Brave**: `BRAVE_API_KEY` أو `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY` أو `PERPLEXITY_API_KEY` أو `tools.web.search.perplexity.apiKey`

### التهيئة

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

### Tool parameters

- `query` (مطلوب)
- `count` (من 1 إلى 10؛ الافتراضي من التهيئة)
- `country` (اختياري): رمز بلد من حرفين لنتائج خاصة بالمنطقة (مثل "DE" و"US" و"ALL"). إذا أُهمل، يختار Brave منطقته الافتراضية.
- `search_lang` (اختياري): رمز لغة ISO لنتائج البحث (مثل "de" و"en" و"fr")
- `ui_lang` (اختياري): رمز لغة ISO لعناصر واجهة المستخدم
- `freshness` (اختياري، Brave فقط): التصفية حسب وقت الاكتشاف (`pd`، `pw`، `pm`، `py`، أو `YYYY-MM-DDtoYYYY-MM-DD`)

**أمثلة:**

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

جلب رابط واستخراج محتوى قابل للقراءة.

### متطلبات web_fetch

- يجب ألا يكون `tools.web.fetch.enabled` مساويًا لـ `false` (الافتراضي: مفعّل)
- بديل Firecrawl اختياري: اضبط `tools.web.fetch.firecrawl.apiKey` أو `FIRECRAWL_API_KEY`.

### تهيئة web_fetch

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

### معاملات أداة web_fetch

- `url` (مطلوب، http/https فقط)
- `extractMode` (`markdown` | `text`)
- `maxChars` (اقتطاع الصفحات الطويلة)

ملاحظات:

- `web_fetch` يستخدم Readability (استخراج المحتوى الرئيسي) أولًا، ثم Firecrawl (إذا تم تهيئته). إذا فشل الاثنان، تعيد الأداة خطأً.
- تستخدم طلبات Firecrawl وضع تجاوز قيود البوتات وتخزّن النتائج مؤقتًا افتراضيًا.
- `web_fetch` يرسل User-Agent شبيهًا بـ Chrome و`Accept-Language` افتراضيًا؛ يمكنك تجاوز `userAgent` عند الحاجة.
- `web_fetch` يحظر أسماء المضيفين الخاصة/الداخلية ويعيد التحقق من عمليات إعادة التوجيه (حدّد ذلك باستخدام `maxRedirects`).
- `maxChars` مُقيَّد إلى `tools.web.fetch.maxCharsCap`.
- `web_fetch` هو استخراج بأفضل جهد؛ بعض المواقع ستحتاج إلى أداة المتصفح.
- انظر [Firecrawl](/tools/firecrawl) لإعداد المفاتيح وتفاصيل الخدمة.
- يتم تخزين الاستجابات مؤقتًا (الافتراضي 15 دقيقة) لتقليل الجلب المتكرر.
- إذا كنت تستخدم ملفات تعريف/قوائم سماح للأدوات، أضف `web_search`/`web_fetch` أو `group:web`.
- إذا كان مفتاح Brave مفقودًا، يعيد `web_search` تلميح إعداد قصيرًا مع رابط إلى المستندات.
