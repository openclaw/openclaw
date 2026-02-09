---
summary: "ဝဘ်ရှာဖွေရန် + ဖတ်ယူရန် ကိရိယာများ (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - web_search သို့မဟုတ် web_fetch ကို ဖွင့်အသုံးပြုလိုသောအခါ
  - Brave Search API key ကို တပ်ဆင်သတ်မှတ်ရန် လိုအပ်သောအခါ
  - ဝဘ်ရှာဖွေရန် Perplexity Sonar ကို အသုံးပြုလိုသောအခါ
title: "Web Tools"
---

# Web tools

OpenClaw တွင် ပေါ့ပါးသည့် ဝဘ်ကိရိယာ ၂ မျိုး ပါဝင်ပါသည်—

- `web_search` — Brave Search API (ပုံမှန်) သို့မဟုတ် Perplexity Sonar (တိုက်ရိုက် သို့မဟုတ် OpenRouter မှတစ်ဆင့်) ကို အသုံးပြုပြီး ဝဘ်ကို ရှာဖွေပါသည်။
- `web_fetch` — HTTP fetch + ဖတ်ရှုရန် အဆင်ပြေသော ထုတ်ယူမှု (HTML → markdown/text)။

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` သည် သင်သတ်မှတ်ထားသော provider ကို ခေါ်ယူပြီး ရလဒ်များကို ပြန်ပို့ပါသည်။
  - **Brave** (ပုံမှန်): ဖွဲ့စည်းထားသော ရလဒ်များ (ခေါင်းစဉ်၊ URL၊ အကျဉ်းချုပ်) ကို ပြန်ပို့ပါသည်။
  - **Perplexity**: အချိန်နှင့်တပြေးညီ ဝဘ်ရှာဖွေမှုမှ အညွှန်းကိုးကားများ ပါဝင်သည့် AI စုပေါင်းထားသော အဖြေများကို ပြန်ပို့ပါသည်။
- ရလဒ်များကို query အလိုက် မိနစ် ၁၅ ခန့် cache လုပ်ထားပါသည် (ပြင်ဆင်နိုင်ပါသည်)။
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` ကို ပုံမှန်အားဖြင့် ဖွင့်ထားပါသည် (အထူးသဖြင့် ပိတ်မထားလျှင်)။

## Choosing a search provider

| Provider                               | အားသာချက်များ                                   | အားနည်းချက်များ                                      | API Key                                             |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| **Brave** (ပုံမှန်) | မြန်ဆန်၊ ဖွဲ့စည်းထားသော ရလဒ်များ၊ free tier     | ရိုးရာ search ရလဒ်များသာ                             | `BRAVE_API_KEY`                                     |
| **Perplexity**                         | AI စုပေါင်းအဖြေများ၊ ကိုးကားချက်များ၊ real-time | Perplexity သို့မဟုတ် OpenRouter အသုံးပြုခွင့် လိုအပ် | `OPENROUTER_API_KEY` သို့မဟုတ် `PERPLEXITY_API_KEY` |

Provider အလိုက် အသေးစိတ်အချက်အလက်များအတွက် [Brave Search setup](/brave-search) နှင့် [Perplexity Sonar](/perplexity) ကို ကြည့်ပါ။

Config တွင် provider ကို သတ်မှတ်ပါ—

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

ဥပမာ- Perplexity Sonar (direct API) သို့ ပြောင်းလဲရန်—

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

## Getting a Brave API key

1. [https://brave.com/search/api/](https://brave.com/search/api/) တွင် Brave Search API အကောင့် ဖန်တီးပါ။
2. Dashboard တွင် **Data for Search** plan ကို ရွေးချယ်ပြီး (“Data for AI” မရွေးပါ) API key တစ်ခု ထုတ်ယူပါ။
3. Config ထဲတွင် key ကို သိမ်းဆည်းရန် (အကြံပြုထားသည်) `openclaw configure --section web` ကို run လုပ်ပါ၊ သို့မဟုတ် သင့် environment တွင် `BRAVE_API_KEY` ကို သတ်မှတ်ပါ။

Brave သည် free tier နှင့် အခကြေးငွေဖြင့် အသုံးပြုနိုင်သော plan များကို ပံ့ပိုးပါသည်။ လက်ရှိ ကန့်သတ်ချက်များနှင့် စျေးနှုန်းများအတွက် Brave API portal ကို စစ်ဆေးပါ။

### Where to set the key (recommended)

**Recommended:** run `openclaw configure --section web`. It stores the key in
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. For a gateway install, put it in `~/.openclaw/.env` (or your
service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Using Perplexity (direct or via OpenRouter)

Perplexity Sonar models have built-in web search capabilities and return AI-synthesized
answers with citations. You can use them via OpenRouter (no credit card required - supports
crypto/prepaid).

### Getting an OpenRouter API key

1. [https://openrouter.ai/](https://openrouter.ai/) တွင် အကောင့် ဖန်တီးပါ။
2. Credit များ ထည့်ပါ (crypto၊ prepaid သို့မဟုတ် credit card ကို ထောက်ပံ့ပါသည်)။
3. Account settings တွင် API key တစ်ခု ထုတ်ယူပါ။

### Setting up Perplexity search

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

**Environment alternative:** set `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` in the Gateway
environment. For a gateway install, put it in `~/.openclaw/.env`.

Base URL ကို မသတ်မှတ်ထားပါက API key အရင်းအမြစ်အပေါ် မူတည်ပြီး OpenClaw က ပုံမှန်တန်ဖိုးကို ရွေးချယ်ပါသည်—

- `PERPLEXITY_API_KEY` သို့မဟုတ် `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` သို့မဟုတ် `sk-or-...` → `https://openrouter.ai/api/v1`
- မသိရသော key format များ → OpenRouter (လုံခြုံသော fallback)

### Available Perplexity models

| Model                                               | ဖော်ပြချက်                                           | အကောင်းဆုံးအသုံးပြုရန်    |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| `perplexity/sonar`                                  | ဝဘ်ရှာဖွေမှုပါဝင်သော မြန်ဆန် Q&A | အမြန်ရှာဖွေမှုများ        |
| `perplexity/sonar-pro` (ပုံမှန်) | ဝဘ်ရှာဖွေမှုပါဝင်သော အဆင့်များစွာ ဆင်ခြင်ခြင်း       | ရှုပ်ထွေးသော မေးခွန်းများ |
| `perplexity/sonar-reasoning-pro`                    | Chain-of-thought ခွဲခြမ်းစိတ်ဖြာခြင်း                | အနက်ရှိုင်း သုတေသန        |

## web_search

သင်သတ်မှတ်ထားသော provider ကို အသုံးပြုပြီး ဝဘ်ကို ရှာဖွေပါသည်။

### Requirements

- `tools.web.search.enabled` သည် `false` မဖြစ်ရပါ (ပုံမှန်: ဖွင့်ထားသည်)
- ရွေးချယ်ထားသော provider အတွက် API key—
  - **Brave**: `BRAVE_API_KEY` သို့မဟုတ် `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, သို့မဟုတ် `tools.web.search.perplexity.apiKey`

### Config

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

- `query` (လိုအပ်)
- `count` (1–10; config မှ ပုံမှန်တန်ဖိုး)
- `country` (optional): 2-letter country code for region-specific results (e.g., "DE", "US", "ALL"). If omitted, Brave chooses its default region.
- `search_lang` (optional): ရှာဖွေရလဒ်များအတွက် ISO ဘာသာစကားကုဒ် (ဥပမာ "de", "en", "fr")
- `ui_lang` (optional): UI အစိတ်အပိုင်းများအတွက် ISO ဘာသာစကားကုဒ်
- `freshness` (optional, Brave only): discovery time အလိုက် စစ်ထုတ်ခြင်း (`pd`, `pw`, `pm`, `py`, သို့မဟုတ် `YYYY-MM-DDtoYYYY-MM-DD`)

**Examples:**

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

URL တစ်ခုကို ဖတ်ယူပြီး ဖတ်ရှုနိုင်သော အကြောင်းအရာကို ထုတ်ယူပါသည်။

### web_fetch requirements

- `tools.web.fetch.enabled` သည် `false` မဖြစ်ရပါ (ပုံမှန်: ဖွင့်ထားသည်)
- Optional Firecrawl fallback: `tools.web.fetch.firecrawl.apiKey` သို့မဟုတ် `FIRECRAWL_API_KEY` ကို သတ်မှတ်ပါ။

### web_fetch config

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

### web_fetch tool parameters

- `url` (လိုအပ်, http/https သာ)
- `extractMode` (`markdown` | `text`)
- `maxChars` (စာမျက်နှာရှည်များကို ချုံ့ရန်)

Notes:

- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.
- Firecrawl request များသည် bot-circumvention mode ကို အသုံးပြုပြီး ပုံမှန်အားဖြင့် ရလဒ်များကို cache လုပ်ပါသည်။
- `web_fetch` သည် Chrome တူသော User-Agent နှင့် `Accept-Language` ကို ပုံမှန်အားဖြင့် ပို့ပါသည်။ လိုအပ်ပါက `userAgent` ဖြင့် override လုပ်နိုင်ပါသည်။
- `web_fetch` သည် private/internal hostnames များကို ပိတ်ဆို့ပြီး redirect များကို ပြန်လည်စစ်ဆေးပါသည် (`maxRedirects` ဖြင့် ကန့်သတ်နိုင်သည်)။
- `maxChars` ကို `tools.web.fetch.maxCharsCap` အတွင်းတွင် ကန့်သတ်ထားပါသည်။
- `web_fetch` သည် best-effort ထုတ်ယူမှု ဖြစ်ပြီး ဆိုက်အချို့တွင် browser tool ကို လိုအပ်နိုင်ပါသည်။
- Key တပ်ဆင်ခြင်းနှင့် ဝန်ဆောင်မှု အသေးစိတ်များအတွက် [Firecrawl](/tools/firecrawl) ကို ကြည့်ပါ။
- ထပ်ခါတလဲလဲ fetch များကို လျှော့ချရန် တုံ့ပြန်ချက်များကို cache လုပ်ထားပါသည် (ပုံမှန် ၁၅ မိနစ်)။
- Tool profiles/allowlists ကို အသုံးပြုပါက `web_search`/`web_fetch` သို့မဟုတ် `group:web` ကို ထည့်ပါ။
- Brave key မရှိပါက `web_search` သည် docs link ပါဝင်သော setup hint အတိုချုံးကို ပြန်ပို့ပါသည်။
