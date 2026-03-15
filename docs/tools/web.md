---
summary: "Web search + fetch tools (Brave, Gemini, Grok, Kimi, and Perplexity providers)"
read_when:
  - You want to enable web_search or web_fetch
  - You need provider API key setup
  - You want to use Gemini with Google Search grounding
title: "Web Tools"
---

# Web tools

OpenClaw ships two lightweight web tools:

- `web_search` — Search the web using Brave Search API, Gemini with Google Search grounding, Grok, Kimi, or Perplexity Search API.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls your configured provider and returns results.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).

See [Brave Search setup](/brave-search) and [Perplexity Search setup](/perplexity) for provider-specific details.

## Choosing a search provider

| Provider                  | Result shape                       | Provider-specific filters                    | Notes                                                                          | API key                                     |
| ------------------------- | ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| **Brave Search API**      | Structured results with snippets   | `country`, `language`, `ui_lang`, time       | Supports Brave `llm-context` mode                                              | `BRAVE_API_KEY`                             |
| **Gemini**                | AI-synthesized answers + citations | —                                            | Uses Google Search grounding                                                   | `GEMINI_API_KEY`                            |
| **Grok**                  | AI-synthesized answers + citations | —                                            | Uses xAI web-grounded responses                                                | `XAI_API_KEY`                               |
| **Kimi**                  | AI-synthesized answers + citations | —                                            | Uses Moonshot web search                                                       | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| **Perplexity Search API** | Structured results with snippets   | `country`, `language`, time, `domain_filter` | Supports content extraction controls; OpenRouter uses Sonar compatibility path | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |

### Auto-detection

The table above is alphabetical. If no `provider` is explicitly set, runtime auto-detection checks providers in this order:

1. **Brave** — `BRAVE_API_KEY` env var or `tools.web.search.apiKey` config
2. **Gemini** — `GEMINI_API_KEY` env var or `tools.web.search.gemini.apiKey` config
3. **Grok** — `XAI_API_KEY` env var or `tools.web.search.grok.apiKey` config
4. **Kimi** — `KIMI_API_KEY` / `MOONSHOT_API_KEY` env var or `tools.web.search.kimi.apiKey` config
5. **Perplexity** — `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `tools.web.search.perplexity.apiKey` config

If no keys are found, it falls back to Brave (you'll get a missing-key error prompting you to configure one).

Runtime SecretRef behavior:

- Web tool SecretRefs are resolved atomically at gateway startup/reload.
- In auto-detect mode, OpenClaw resolves only the selected provider key. Non-selected provider SecretRefs stay inactive until selected.
- If the selected provider SecretRef is unresolved and no provider env fallback exists, startup/reload fails fast.

## Setting up web search

Use `openclaw configure --section web` to set up your API key and choose a provider.

### Brave Search

1. Create a Brave Search API account at [brave.com/search/api](https://brave.com/search/api/)
2. In the dashboard, choose the **Search** plan and generate an API key.
3. Run `openclaw configure --section web` to store the key in config, or set `BRAVE_API_KEY` in your environment.

Each Brave plan includes **\$5/month in free credit** (renewing). The Search
plan costs \$5 per 1,000 requests, so the credit covers 1,000 queries/month. Set
your usage limit in the Brave dashboard to avoid unexpected charges. See the
[Brave API portal](https://brave.com/search/api/) for current plans and
pricing.

### Perplexity Search

1. Create a Perplexity account at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
2. Generate an API key in the dashboard
3. Run `openclaw configure --section web` to store the key in config, or set `PERPLEXITY_API_KEY` in your environment.

For legacy Sonar/OpenRouter compatibility, set `OPENROUTER_API_KEY` instead, or configure `tools.web.search.perplexity.apiKey` with an `sk-or-...` key. Setting `tools.web.search.perplexity.baseUrl` or `model` also opts Perplexity back into the chat-completions compatibility path.

See [Perplexity Search API Docs](https://docs.perplexity.ai/guides/search-quickstart) for more details.

### Where to store the key

**Via config:** run `openclaw configure --section web`. It stores the key under the provider-specific config path:

- Brave: `tools.web.search.apiKey`
- Gemini: `tools.web.search.gemini.apiKey`
- Grok: `tools.web.search.grok.apiKey`
- Kimi: `tools.web.search.kimi.apiKey`
- Perplexity: `tools.web.search.perplexity.apiKey`

All of these fields also support SecretRef objects.

**Via environment:** set provider env vars in the Gateway process environment:

- Brave: `BRAVE_API_KEY`
- Gemini: `GEMINI_API_KEY`
- Grok: `XAI_API_KEY`
- Kimi: `KIMI_API_KEY` or `MOONSHOT_API_KEY`
- Perplexity: `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`

For a gateway install, put these in `~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

### Config examples

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

**Brave LLM Context mode:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
        brave: {
          mode: "llm-context",
        },
      },
    },
  },
}
```

`llm-context` returns extracted page chunks for grounding instead of standard Brave snippets.
In this mode, `country` and `language` / `search_lang` still work, but `ui_lang`,
`freshness`, `date_after`, and `date_before` are rejected.

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

**Perplexity via OpenRouter / Sonar compatibility:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: "<openrouter-api-key>", // optional if OPENROUTER_API_KEY is set
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
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
  - **Gemini**: `GEMINI_API_KEY` or `tools.web.search.gemini.apiKey`
  - **Grok**: `XAI_API_KEY` or `tools.web.search.grok.apiKey`
  - **Kimi**: `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `tools.web.search.kimi.apiKey`
  - **Perplexity**: `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `tools.web.search.perplexity.apiKey`
- All provider key fields above support SecretRef objects.

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

All parameters work for Brave and for native Perplexity Search API unless noted.

Perplexity's OpenRouter / Sonar compatibility path supports only `query` and `freshness`.
If you set `tools.web.search.perplexity.baseUrl` / `model`, use `OPENROUTER_API_KEY`, or configure an `sk-or-...` key, Search API-only filters return explicit errors.

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
| `domain_filter`       | Domain allowlist/denylist array (Perplexity only)     |
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

// Domain filtering (Perplexity only)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Exclude domains (Perplexity only)
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

When Brave `llm-context` mode is enabled, `ui_lang`, `freshness`, `date_after`, and
`date_before` are not supported. Use Brave `web` mode for those filters.

## web_fetch

Fetch a URL and extract readable content.

### web_fetch requirements

- `tools.web.fetch.enabled` must not be `false` (default: enabled)
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.
- `tools.web.fetch.firecrawl.apiKey` supports SecretRef objects.

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
- Firecrawl SecretRefs are resolved only when Firecrawl is active (`tools.web.fetch.enabled !== false` and `tools.web.fetch.firecrawl.enabled !== false`).
- If Firecrawl is active and its SecretRef is unresolved with no `FIRECRAWL_API_KEY` fallback, startup/reload fails fast.
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.
- `web_fetch` blocks private/internal hostnames and re-checks redirects (limit with `maxRedirects`).
- `maxChars` is clamped to `tools.web.fetch.maxCharsCap`.
- `web_fetch` caps the downloaded response body size to `tools.web.fetch.maxResponseBytes` before parsing; oversized responses are truncated and include a warning.
- `web_fetch` is best-effort extraction; some sites will need the browser tool.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes) to reduce repeated fetches.
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.
- If the API key is missing, `web_search` returns a short setup hint with a docs link. If you don't want to configure a search API key, you can often use `web_fetch` (URL fetch) or the `browser` tool instead.
