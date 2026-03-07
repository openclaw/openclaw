---
summary: "Web search + fetch tools (Perplexity Search API, Brave, Gemini, Grok, and Kimi providers)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Perplexity or Brave Search API key setup
  - You want to use Gemini with Google Search grounding
title: "Web Tools"
---

# Web tools

OpenClaw ships two lightweight web tools:

- `web_search` — Search the web using Perplexity Search API, Brave Search API, Gemini with Google Search grounding, Grok, or Kimi.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls your configured provider and returns results.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).

See [Perplexity Search setup](/perplexity) and [Brave Search setup](/brave-search) for provider-specific details.

## Choosing a search provider

| Provider                  | Pros                                                                                          | Cons                                        | API Key                             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| **Perplexity Search API** | Fast, structured results; domain, language, region, and freshness filters; content extraction | —                                           | `PERPLEXITY_API_KEY`                |
| **Brave Search API**      | Fast, structured results; domain, language, region, and freshness filters                     | AI-use terms apply                          | `BRAVE_API_KEY`                     |
| **Gemini**                | Google Search grounding, AI-synthesized                                                       | Requires Gemini API key                     | `GEMINI_API_KEY`                    |
| **Grok**                  | xAI web-grounded responses                                                                    | Requires xAI API key                        | `XAI_API_KEY`                       |
| **Kimi**                  | Moonshot web search capability                                                                | Requires Moonshot API key                   | `KIMI_API_KEY` / `MOONSHOT_API_KEY` |

### Auto-detection

If no `provider` is explicitly set, OpenClaw auto-detects which provider to use based on available API keys, checking in this order:

1. **Brave** — `BRAVE_API_KEY` env var or `tools.web.search.apiKey` config
2. **Gemini** — `GEMINI_API_KEY` env var or `tools.web.search.gemini.apiKey` config
3. **Kimi** — `KIMI_API_KEY` / `MOONSHOT_API_KEY` env var or `tools.web.search.kimi.apiKey` config
4. **Perplexity** — `PERPLEXITY_API_KEY` env var or `tools.web.search.perplexity.apiKey` config
5. **Grok** — `XAI_API_KEY` env var or `tools.web.search.grok.apiKey` config

If no keys are found, it falls back to Brave (you'll get a missing-key error prompting you to configure one).

## Setting up web search

Use `openclaw configure --section web` to set up your API key and choose a provider.

### Perplexity Search

1. Create a Perplexity account at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
2. Generate an API key in the dashboard
3. Run `openclaw configure --section web` to store the key in config, or set `PERPLEXITY_API_KEY` in your environment.

See [Perplexity Search API Docs](https://docs.perplexity.ai/guides/search-quickstart) for more details.

### Brave Search

1. Create a Brave Search API account at [brave.com/search/api](https://brave.com/search/api/)
2. In the dashboard, choose the **Data for Search** plan (not "Data for AI") and generate an API key.
3. Run `openclaw configure --section web` to store the key in config (recommended), or set `BRAVE_API_KEY` in your environment.

Brave provides paid plans; check the Brave API portal for the current limits and pricing.

### Where to store the key

**Via config (recommended):** run `openclaw configure --section web`. It stores the key under `tools.web.search.perplexity.apiKey` or `tools.web.search.apiKey`.

**Via environment:** set `PERPLEXITY_API_KEY` or `BRAVE_API_KEY` in the Gateway process environment. For a gateway install, put it in `~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

### Config examples

**Perplexity Search:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...", // optional if PERPLEXITY_API_KEY is set
        },
      },
    },
  },
}
```

**Brave Search:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
      },
    },
  },
}
```

## Using Gemini (Google Search grounding)

Gemini models support built-in [Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding),
which returns AI-synthesized answers backed by live Google Search results with citations.

### Getting a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Set `GEMINI_API_KEY` in the Gateway environment, or configure `tools.web.search.gemini.apiKey`

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

**Environment alternative:** set `GEMINI_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

### Notes

- Citation URLs from Gemini grounding are automatically resolved from Google's
  redirect URLs to direct URLs.
- Redirect resolution uses the SSRF guard path (HEAD + redirect checks + http/https validation) before returning the final citation URL.
- Redirect resolution uses strict SSRF defaults, so redirects to private/internal targets are blocked.
- The default model (`gemini-2.5-flash`) is fast and cost-effective.
  Any Gemini model that supports grounding can be used.

## web_search

Search the web using your configured provider.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider:
  - **Brave**: `BRAVE_API_KEY` or `tools.web.search.apiKey`
  - **Perplexity**: `PERPLEXITY_API_KEY` or `tools.web.search.perplexity.apiKey`
  - **Gemini**: `GEMINI_API_KEY` or `tools.web.search.gemini.apiKey`
  - **Grok**: `XAI_API_KEY` or `tools.web.search.grok.apiKey`
  - **Kimi**: `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `tools.web.search.kimi.apiKey`

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

All parameters work for both Brave and Perplexity unless noted.

| Parameter             | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `query`               | Search query (required)                               |
| `count`               | Results to return (1-10, default: 5)                  |
| `country`             | 2-letter ISO country code (e.g., "US", "DE")          |
| `language`            | ISO 639-1 language code (e.g., "en", "de")            |
| `freshness`           | Time filter: `day`, `week`, `month`, or `year`        |
| `date_after`          | Results after this date (YYYY-MM-DD)                  |
| `date_before`         | Results before this date (YYYY-MM-DD)                 |
| `ui_lang`             | UI language code (Brave only)                         |
| `domain_filter`       | Domain allowlist/denylist array (Brave, Perplexity)   |
| `max_tokens`          | Total content budget, default 25000 (Perplexity only) |
| `max_tokens_per_page` | Per-page token limit, default 2048 (Perplexity only)  |

**Examples:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  country: "DE",
  language: "de",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "week",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Domain filtering (Brave, Perplexity)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Exclude domains (Brave, Perplexity)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// More content extraction (Perplexity only)
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

## web_fetch

Fetch a URL and extract readable content.

### web_fetch requirements

- `tools.web.fetch.enabled` must not be `false` (default: enabled)
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.

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

- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.
- Firecrawl requests use bot-circumvention mode and cache results by default.
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.
- `web_fetch` blocks private/internal hostnames and re-checks redirects (limit with `maxRedirects`).
- `maxChars` is clamped to `tools.web.fetch.maxCharsCap`.
- `web_fetch` caps the downloaded response body size to `tools.web.fetch.maxResponseBytes` before parsing; oversized responses are truncated and include a warning.
- `web_fetch` is best-effort extraction; some sites will need the browser tool.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes) to reduce repeated fetches.
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.
- If the API key is missing, `web_search` returns a short setup hint with a docs link.
