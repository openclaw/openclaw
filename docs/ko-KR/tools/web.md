---
summary: "Web search + fetch tools (Brave Search API, Perplexity direct/OpenRouter, Gemini Google Search grounding)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Brave Search API key setup
  - You want to use Perplexity Sonar for web search
  - You want to use Gemini with Google Search grounding
title: "Web Tools"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/web.md
workflow: 15
---

# Web tools

OpenClaw 는 두 개의 lightweight web tools 를 제공합니다:

- `web_search` — Search the web via Brave Search API (default), Perplexity Sonar, 또는 Gemini with Google Search grounding.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These 는 **not** browser automation 입니다. JS-heavy sites 또는 logins 의 경우, [Browser tool](/tools/browser) 을 사용합니다.

## How it works

- `web_search` 는 configured provider 를 call 하고 results 를 returns 합니다.
  - **Brave** (default): returns structured results (title, URL, snippet).
  - **Perplexity**: returns AI-synthesized answers with citations from real-time web search.
  - **Gemini**: returns AI-synthesized answers grounded in Google Search with citations.
- Results 는 query 의 15 minutes 동안 cached 입니다 (configurable).
- `web_fetch` 는 plain HTTP GET 를 하고 readable content 를 extracts 합니다
  (HTML → markdown/text). 이것은 **not** execute JavaScript 입니다.
- `web_fetch` 는 explicitly disabled 되지 않는 한 기본적으로 enabled 입니다.

## Choosing a search provider

| Provider            | Pros                                         | Cons                                     | API Key                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave** (default) | Fast, structured results, free tier          | Traditional search results               | `BRAVE_API_KEY`                              |
| **Perplexity**      | AI-synthesized answers, citations, real-time | Requires Perplexity or OpenRouter access | `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` |
| **Gemini**          | Google Search grounding, AI-synthesized      | Requires Gemini API key                  | `GEMINI_API_KEY`                             |

[Brave Search setup](/brave-search) 및 [Perplexity Sonar](/perplexity) 을 see 하세요 provider-specific details.

### Auto-detection

No `provider` 이 explicitly set 되지 않으면, OpenClaw auto-detects which provider 를 use 할지 available API keys 를 기준으로 하며, 이 order 를 check 합니다:

1. **Brave** — `BRAVE_API_KEY` env var or `search.apiKey` config
2. **Gemini** — `GEMINI_API_KEY` env var or `search.gemini.apiKey` config
3. **Perplexity** — `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` env var or `search.perplexity.apiKey` config
4. **Grok** — `XAI_API_KEY` env var or `search.grok.apiKey` config

No keys 가 found 되면, 이것은 Brave 로 fallback 합니다 (당신은 missing-key error 을 get 하며 configure 를 prompt 합니다).

### Explicit provider

Provider 를 config 에서 set 합니다:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity" or "gemini"
      },
    },
  },
}
```

Example: switch to Perplexity Sonar (direct API):

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

1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. Dashboard 에서, **Data for Search** plan (not "Data for AI") 을 choose 하고 API key 를 generate 합니다.
3. `openclaw configure --section web` 를 run 하여 key 를 config 에 store 합니다 (recommended), 또는 environment 에서 `BRAVE_API_KEY` 를 set 합니다.

Brave 는 free tier plus paid plans 를 provide 합니다; current limits 및 pricing 에 대해 Brave API portal 을 check 합니다.

### Where to set the key (recommended)

**Recommended:** `openclaw configure --section web` 를 run 합니다. 이것은 key 를 `~/.openclaw/openclaw.json` 에 `tools.web.search.apiKey` 아래에 store 합니다.

**Environment alternative:** Gateway process environment 에서 `BRAVE_API_KEY` 를 set 합니다. Gateway install 의 경우, 이것을 `~/.openclaw/.env` 에 put 합니다 (또는 service environment). [Env vars](/help/faq#how-does-openclaw-load-environment-variables) 을 참고합니다.

## Using Perplexity (direct or via OpenRouter)

Perplexity Sonar models 는 built-in web search capabilities 를 have 하고 citations 를 가진 AI-synthesized answers 를 return 합니다. 당신은 이들을 OpenRouter (no credit card required - supports crypto/prepaid) 를 통해 사용할 수 있습니다.

### Getting an OpenRouter API key

1. [https://openrouter.ai/](https://openrouter.ai/) 에서 account 를 create 합니다
2. Credits 를 add 합니다 (supports crypto, prepaid, 또는 credit card)
3. Account settings 에서 API key 를 generate 합니다

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

**Environment alternative:** Gateway environment 에서 `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY` 를 set 합니다. Gateway install 의 경우, 이것을 `~/.openclaw/.env` 에 put 합니다.

No base URL 이 set 될 때, OpenClaw 는 API key source 를 기준으로 default 를 chooses 합니다:

- `PERPLEXITY_API_KEY` or `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` or `sk-or-...` → `https://openrouter.ai/api/v1`
- Unknown key formats → OpenRouter (safe fallback)

### Available Perplexity models

| Model                            | Description                          | Best for          |
| -------------------------------- | ------------------------------------ | ----------------- |
| `perplexity/sonar`               | Fast Q&A with web search             | Quick lookups     |
| `perplexity/sonar-pro` (default) | Multi-step reasoning with web search | Complex questions |
| `perplexity/sonar-reasoning-pro` | Chain-of-thought analysis            | Deep research     |

## Using Gemini (Google Search grounding)

Gemini models 는 built-in [Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding) 를 support 하며,
이것은 live Google Search results with citations 로 backed AI-synthesized answers 를 returns 합니다.

### Getting a Gemini API key

1. [Google AI Studio](https://aistudio.google.com/apikey) 로 go 합니다
2. API key 를 create 합니다
3. Gateway environment 에서 `GEMINI_API_KEY` 를 set 하거나, `tools.web.search.gemini.apiKey` 를 configure 합니다

### Setting up Gemini search

```json5
{
  tools: {
    web: {
      search: {
        provider: "gemini",
        gemini: {
          // API key (optional if GEMINI_API_KEY is set)
          apiKey: "AIza...",
          // Model (defaults to "gemini-2.5-flash")
          model: "gemini-2.5-flash",
        },
      },
    },
  },
}
```

**Environment alternative:** Gateway environment 에서 `GEMINI_API_KEY` 를 set 합니다.
Gateway install 의 경우, 이것을 `~/.openclaw/.env` 에 put 합니다.

### Notes

- Citation URLs from Gemini grounding 는 automatically resolved 됩니다 Google 's redirect URLs 에서 direct URLs 로.
- Redirect resolution 은 SSRF guard path (HEAD + redirect checks + http/https validation) 을 사용합니다 final citation URL 을 return 하기 전에.
- Redirect resolution 은 strict SSRF defaults 를 use 하므로, redirects to private/internal targets 는 blocked 입니다.
- Default model (`gemini-2.5-flash`) 는 fast 및 cost-effective 입니다.
  Grounding 을 support 하는 any Gemini model 을 use 할 수 있습니다.

## web_search

Configured provider 를 사용하여 web 을 search 합니다.

### Requirements

- `tools.web.search.enabled` 은 `false` 이어야 하지 않습니다 (default: enabled)
- API key for your chosen provider:
  - **Brave**: `BRAVE_API_KEY` or `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, or `tools.web.search.perplexity.apiKey`

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

- `query` (required)
- `count` (1–10; default from config)
- `country` (optional): 2-letter country code for region-specific results (예: "DE", "US", "ALL"). Omitted 될 때, Brave chooses its default region.
- `search_lang` (optional): ISO language code for search results (예: "de", "en", "fr")
- `ui_lang` (optional): ISO language code for UI elements
- `freshness` (optional): filter by discovery time
  - Brave: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`
  - Perplexity: `pd`, `pw`, `pm`, `py`

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

URL 를 fetch 하고 readable content 를 extract 합니다.

### web_fetch requirements

- `tools.web.fetch.enabled` 은 `false` 이어야 하지 않습니다 (default: enabled)
- Optional Firecrawl fallback: `tools.web.fetch.firecrawl.apiKey` 또는 `FIRECRAWL_API_KEY` 를 set 합니다.

### web_fetch config

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
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

- `url` (required, http/https only)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncate long pages)

Notes:

- `web_fetch` 는 Readability (main-content extraction) 를 먼저 use 하고, 그 다음 Firecrawl (if configured). Both fail 하면, tool 은 error 를 return 합니다.
- Firecrawl requests 는 bot-circumvention mode 및 cache results by default 를 use 합니다.
- `web_fetch` 는 Chrome-like User-Agent 및 `Accept-Language` 를 sends by default; needed 하면 `userAgent` 를 override 합니다.
- `web_fetch` 는 private/internal hostnames 를 blocks 하고 redirects 를 re-checks (limit with `maxRedirects`).
- `maxChars` 는 `tools.web.fetch.maxCharsCap` 로 clamped 됩니다.
- `web_fetch` 는 downloaded response body size 를 `tools.web.fetch.maxResponseBytes` 로 cap 합니다 before parsing; oversized responses 는 truncated 되고 warning 을 include 합니다.
- `web_fetch` 는 best-effort extraction 입니다; some sites 는 browser tool 이 필요할 것입니다.
- [Firecrawl](/tools/firecrawl) 참고 key setup 및 service details 를 위해.
- Responses 는 cached (default 15 minutes) 되어 repeated fetches 를 reduce 합니다.
- Tool profiles/allowlists 를 use 하면, `web_search`/`web_fetch` 또는 `group:web` 을 add 합니다.
- Brave key 가 missing 하면, `web_search` 는 short setup hint 를 return 합니다 with a docs link.
