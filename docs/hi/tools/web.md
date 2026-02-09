---
summary: "वेब खोज + फ़ेच टूल्स (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - आप web_search या web_fetch सक्षम करना चाहते हैं
  - आपको Brave Search API कुंजी सेटअप की आवश्यकता है
  - आप वेब खोज के लिए Perplexity Sonar का उपयोग करना चाहते हैं
title: "वेब टूल्स"
---

# वेब टूल्स

OpenClaw दो हल्के वेब टूल्स प्रदान करता है:

- `web_search` — Brave Search API (डिफ़ॉल्ट) या Perplexity Sonar (direct या OpenRouter के माध्यम से) के जरिए वेब खोज।
- `web_fetch` — HTTP फ़ेच + पठनीय निष्कर्षण (HTML → markdown/text)।

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## यह कैसे काम करता है

- `web_search` आपके कॉन्फ़िगर किए गए प्रदाता को कॉल करता है और परिणाम लौटाता है।
  - **Brave** (डिफ़ॉल्ट): संरचित परिणाम लौटाता है (शीर्षक, URL, स्निपेट)।
  - **Perplexity**: रियल-टाइम वेब खोज से उद्धरणों सहित AI-संश्लेषित उत्तर लौटाता है।
- परिणाम 15 मिनट के लिए क्वेरी के आधार पर कैश किए जाते हैं (कॉन्फ़िगर करने योग्य)।
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` डिफ़ॉल्ट रूप से सक्षम है (जब तक स्पष्ट रूप से अक्षम न किया जाए)।

## खोज प्रदाता चुनना

| प्रदाता                                 | लाभ                                   | सीमाएँ                                 | API कुंजी                                    |
| --------------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------------------- |
| **Brave** (डिफ़ॉल्ट) | तेज़, संरचित परिणाम, मुफ़्त टियर      | पारंपरिक खोज परिणाम                    | `BRAVE_API_KEY`                              |
| **Perplexity**                          | AI-संश्लेषित उत्तर, उद्धरण, रियल-टाइम | Perplexity या OpenRouter एक्सेस आवश्यक | `OPENROUTER_API_KEY` या `PERPLEXITY_API_KEY` |

प्रदाता-विशिष्ट विवरणों के लिए [Brave Search सेटअप](/brave-search) और [Perplexity Sonar](/perplexity) देखें।

कॉन्फ़िग में प्रदाता सेट करें:

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

उदाहरण: Perplexity Sonar (direct API) पर स्विच करें:

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

## Brave API कुंजी प्राप्त करना

1. [https://brave.com/search/api/](https://brave.com/search/api/) पर Brave Search API खाता बनाएँ
2. डैशबोर्ड में **Data for Search** प्लान चुनें (“Data for AI” नहीं) और एक API कुंजी जनरेट करें।
3. कुंजी को कॉन्फ़िग में संग्रहीत करने के लिए (अनुशंसित) `openclaw configure --section web` चलाएँ, या अपने पर्यावरण में `BRAVE_API_KEY` सेट करें।

Brave मुफ़्त टियर और सशुल्क प्लान प्रदान करता है; वर्तमान सीमाएँ और मूल्य निर्धारण के लिए Brave API पोर्टल देखें।

### कुंजी कहाँ सेट करें (अनुशंसित)

**Recommended:** run `openclaw configure --section web`. It stores the key in
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. For a gateway install, put it in `~/.openclaw/.env` (or your
service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Perplexity का उपयोग (direct या OpenRouter के माध्यम से)

Perplexity Sonar models have built-in web search capabilities and return AI-synthesized
answers with citations. 1. आप इन्हें OpenRouter के माध्यम से उपयोग कर सकते हैं (क्रेडिट कार्ड की आवश्यकता नहीं — क्रिप्टो/प्रीपेड समर्थित)।

### OpenRouter API कुंजी प्राप्त करना

1. [https://openrouter.ai/](https://openrouter.ai/) पर खाता बनाएँ
2. क्रेडिट जोड़ें (क्रिप्टो, प्रीपेड, या क्रेडिट कार्ड समर्थित)
3. अपने खाता सेटिंग्स में एक API कुंजी जनरेट करें

### Perplexity खोज सेटअप करना

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

2. **Environment विकल्प:** Gateway environment में `OPENROUTER_API_KEY` या `PERPLEXITY_API_KEY` सेट करें। 3. Gateway इंस्टॉल के लिए, इसे `~/.openclaw/.env` में रखें।

यदि कोई base URL सेट नहीं है, तो OpenClaw API कुंजी स्रोत के आधार पर एक डिफ़ॉल्ट चुनता है:

- `PERPLEXITY_API_KEY` या `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` या `sk-or-...` → `https://openrouter.ai/api/v1`
- अज्ञात कुंजी फ़ॉर्मैट → OpenRouter (सुरक्षित फ़ॉलबैक)

### उपलब्ध Perplexity मॉडल्स

| मॉडल                                                 | विवरण                                       | सर्वोत्तम उपयोग |
| ---------------------------------------------------- | ------------------------------------------- | --------------- |
| `perplexity/sonar`                                   | वेब खोज के साथ तेज़ Q&A | त्वरित लुकअप    |
| `perplexity/sonar-pro` (डिफ़ॉल्ट) | वेब खोज के साथ बहु-चरणीय तर्क               | जटिल प्रश्न     |
| `perplexity/sonar-reasoning-pro`                     | Chain-of-thought विश्लेषण                   | गहन शोध         |

## web_search

अपने कॉन्फ़िगर किए गए प्रदाता का उपयोग करके वेब खोजें।

### आवश्यकताएँ

- `tools.web.search.enabled` `false` नहीं होना चाहिए (डिफ़ॉल्ट: सक्षम)
- आपके चुने हुए प्रदाता के लिए API कुंजी:
  - **Brave**: `BRAVE_API_KEY` या `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, या `tools.web.search.perplexity.apiKey`

### कॉन्फ़िग

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

### टूल पैरामीटर्स

- `query` (आवश्यक)
- `count` (1–10; डिफ़ॉल्ट कॉन्फ़िग से)
- 4. `country` (वैकल्पिक): क्षेत्र-विशिष्ट परिणामों के लिए 2-अक्षरों का देश कोड (जैसे, "DE", "US", "ALL")। 5. यदि छोड़ा गया, तो Brave अपना डिफ़ॉल्ट क्षेत्र चुनता है।
- `search_lang` (वैकल्पिक): खोज परिणामों के लिए ISO भाषा कोड (जैसे, "de", "en", "fr")
- `ui_lang` (वैकल्पिक): UI तत्वों के लिए ISO भाषा कोड
- `freshness` (वैकल्पिक, केवल Brave): खोज समय के आधार पर फ़िल्टर (`pd`, `pw`, `pm`, `py`, या `YYYY-MM-DDtoYYYY-MM-DD`)

**उदाहरण:**

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

किसी URL को फ़ेच करें और पठनीय सामग्री निकालें।

### web_fetch आवश्यकताएँ

- `tools.web.fetch.enabled` `false` नहीं होना चाहिए (डिफ़ॉल्ट: सक्षम)
- वैकल्पिक Firecrawl फ़ॉलबैक: `tools.web.fetch.firecrawl.apiKey` या `FIRECRAWL_API_KEY` सेट करें।

### web_fetch कॉन्फ़िग

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

### web_fetch टूल पैरामीटर्स

- `url` (आवश्यक, केवल http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (लंबे पृष्ठों को ट्रंकेट करें)

टिप्पणियाँ:

- 6. `web_fetch` पहले Readability (मुख्य-सामग्री निष्कर्षण) का उपयोग करता है, फिर Firecrawl (यदि कॉन्फ़िगर किया गया हो)। 7. यदि दोनों विफल हों, तो टूल एक त्रुटि लौटाता है।
- Firecrawl अनुरोध bot-circumvention मोड का उपयोग करते हैं और डिफ़ॉल्ट रूप से परिणाम कैश करते हैं।
- `web_fetch` डिफ़ॉल्ट रूप से Chrome-जैसा User-Agent और `Accept-Language` भेजता है; आवश्यकता होने पर `userAgent` को ओवरराइड करें।
- `web_fetch` निजी/आंतरिक होस्टनेम्स को ब्लॉक करता है और रीडायरेक्ट्स को पुनः जाँचता है (सीमा `maxRedirects` के साथ)।
- `maxChars` को `tools.web.fetch.maxCharsCap` तक क्लैम्प किया जाता है।
- `web_fetch` सर्वोत्तम-प्रयास निष्कर्षण है; कुछ साइटों के लिए ब्राउज़र टूल की आवश्यकता होगी।
- कुंजी सेटअप और सेवा विवरणों के लिए [Firecrawl](/tools/firecrawl) देखें।
- दोहराए गए फ़ेच को कम करने के लिए प्रतिक्रियाएँ कैश की जाती हैं (डिफ़ॉल्ट 15 मिनट)।
- यदि आप टूल प्रोफ़ाइल/allowlists का उपयोग करते हैं, तो `web_search`/`web_fetch` या `group:web` जोड़ें।
- यदि Brave कुंजी अनुपलब्ध है, तो `web_search` दस्तावेज़ लिंक के साथ एक संक्षिप्त सेटअप संकेत लौटाता है।
