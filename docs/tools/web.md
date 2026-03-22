---
summary: "Web search + fetch tools (Brave, Firecrawl, Gemini, Grok, Kimi, Perplexity, and Tavily providers)"
read_when:
  - You want to enable web_search or web_fetch
  - You need provider API key setup
  - You want to use Gemini with Google Search grounding
title: "Web Tools"
---

# Web tools

OpenClaw ships two lightweight web tools:

- `web_search` — Search the web using Brave Search API, Firecrawl Search, Gemini with Google Search grounding, Grok, Kimi, Perplexity Search API, or Tavily Search API.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls your configured provider and returns results.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).
- The bundled Firecrawl plugin also adds `firecrawl_search` and `firecrawl_scrape` when enabled.
- The bundled Tavily plugin also adds `tavily_search` and `tavily_extract` when enabled.

See [Brave Search setup](/tools/brave-search), [Perplexity Search setup](/tools/perplexity-search), and [Tavily Search setup](/tools/tavily) for provider-specific details.

## Choosing a search provider

| Provider                                   | Result shape                       | Setup guide                                 |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------- |
| [**Brave Search**](/tools/brave-search)    | Structured results with snippets   | `BRAVE_API_KEY`                             |
| [**Firecrawl**](/tools/firecrawl)          | Structured results with snippets   | `FIRECRAWL_API_KEY`                         |
| [**Gemini**](/tools/gemini-search)         | AI-synthesized answers + citations | `GEMINI_API_KEY`                            |
| [**Grok**](/tools/grok-search)             | AI-synthesized answers + citations | `XAI_API_KEY`                               |
| [**Kimi**](/tools/kimi-search)             | AI-synthesized answers + citations | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| [**Perplexity**](/tools/perplexity-search) | Structured results with snippets   | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| [**Tavily**](/tools/tavily)                | Structured results with snippets   | `TAVILY_API_KEY`                            |

### Auto-detection

The table above is alphabetical. If no `provider` is explicitly set, runtime auto-detection checks providers in this order:

1. **Brave** — `BRAVE_API_KEY` env var or `plugins.entries.brave.config.webSearch.apiKey`
2. **Gemini** — `GEMINI_API_KEY` env var or `plugins.entries.google.config.webSearch.apiKey`
3. **Grok** — `XAI_API_KEY` env var or `plugins.entries.xai.config.webSearch.apiKey`
4. **Kimi** — `KIMI_API_KEY` / `MOONSHOT_API_KEY` env var or `plugins.entries.moonshot.config.webSearch.apiKey`
5. **Perplexity** — `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `plugins.entries.perplexity.config.webSearch.apiKey`
6. **Firecrawl** — `FIRECRAWL_API_KEY` env var or `plugins.entries.firecrawl.config.webSearch.apiKey`
7. **Tavily** — `TAVILY_API_KEY` env var or `plugins.entries.tavily.config.webSearch.apiKey`

If no keys are found, it falls back to Brave (you'll get a missing-key error prompting you to configure one).

Runtime SecretRef behavior:

- Web tool SecretRefs are resolved atomically at gateway startup/reload.
- In auto-detect mode, OpenClaw resolves only the selected provider key. Non-selected provider SecretRefs stay inactive until selected.
- If the selected provider SecretRef is unresolved and no provider env fallback exists, startup/reload fails fast.

## Setting up web search

Run `openclaw configure --section web` to choose a provider and store your API key. For detailed setup, see the provider-specific pages:

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    Structured results with snippets and LLM context mode
  </Card>
  <Card title="Firecrawl" icon="fire" href="/tools/firecrawl">
    Search + scraping with content extraction
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    AI-synthesized answers via Google Search grounding
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    AI-synthesized answers via xAI web grounding
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    AI-synthesized answers via Moonshot web search
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    Structured results with content extraction controls
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    Search depth, topic filtering, and URL extraction
  </Card>
</CardGroup>

Provider-specific web search config lives under `plugins.entries.<plugin>.config.webSearch.*`.

### Where to store the key

**Via config:** run `openclaw configure --section web`. It stores the key under the provider-specific config path:

- Brave: `plugins.entries.brave.config.webSearch.apiKey`
- Firecrawl: `plugins.entries.firecrawl.config.webSearch.apiKey`
- Gemini: `plugins.entries.google.config.webSearch.apiKey`
- Grok: `plugins.entries.xai.config.webSearch.apiKey`
- Kimi: `plugins.entries.moonshot.config.webSearch.apiKey`
- Perplexity: `plugins.entries.perplexity.config.webSearch.apiKey`
- Tavily: `plugins.entries.tavily.config.webSearch.apiKey`

All of these fields also support SecretRef objects.

**Via environment:** set provider env vars in the Gateway process environment:

- Brave: `BRAVE_API_KEY`
- Firecrawl: `FIRECRAWL_API_KEY`
- Gemini: `GEMINI_API_KEY`
- Grok: `XAI_API_KEY`
- Kimi: `KIMI_API_KEY` or `MOONSHOT_API_KEY`
- Perplexity: `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`
- Tavily: `TAVILY_API_KEY`

For a gateway install, put these in `~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

### Config examples

**Brave Search:**

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
      },
    },
  },
}
```

**Firecrawl Search:**

```json5
{
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "firecrawl",
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "fc-...", // optional if FIRECRAWL_API_KEY is set
            baseUrl: "https://api.firecrawl.dev",
          },
        },
      },
    },
  },
}
```

When you choose Firecrawl in onboarding or `openclaw configure --section web`, OpenClaw enables the bundled Firecrawl plugin automatically so `web_search`, `firecrawl_search`, and `firecrawl_scrape` are all available.

**Tavily Search:**

```json5
{
  plugins: {
    entries: {
      tavily: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "tvly-...", // optional if TAVILY_API_KEY is set
            baseUrl: "https://api.tavily.com",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "tavily",
      },
    },
  },
}
```

When you choose Tavily in onboarding or `openclaw configure --section web`, OpenClaw enables the bundled Tavily plugin automatically so `web_search`, `tavily_search`, and `tavily_extract` are all available.

**Brave LLM Context mode:**

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "YOUR_BRAVE_API_KEY", // optional if BRAVE_API_KEY is set // pragma: allowlist secret
            mode: "llm-context",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
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
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...", // optional if PERPLEXITY_API_KEY is set
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
      },
    },
  },
}
```

**Perplexity via OpenRouter / Sonar compatibility:**

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>", // optional if OPENROUTER_API_KEY is set
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
      },
    },
  },
}
```

## web_search

Search the web using your configured provider.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider:
  - **Brave**: `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey`
  - **Firecrawl**: `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
  - **Gemini**: `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey`
  - **Grok**: `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey`
  - **Kimi**: `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `plugins.entries.moonshot.config.webSearch.apiKey`
  - **Perplexity**: `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `plugins.entries.perplexity.config.webSearch.apiKey`
  - **Tavily**: `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey`
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

Parameters depend on the selected provider.

Perplexity's OpenRouter / Sonar compatibility path supports only `query` and `freshness`.
If you set `plugins.entries.perplexity.config.webSearch.baseUrl` / `model`, use `OPENROUTER_API_KEY`, or configure an `sk-or-...` key under `plugins.entries.perplexity.config.webSearch.apiKey`, Search API-only filters return explicit errors.

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

Firecrawl `web_search` supports `query` and `count`. For Firecrawl-specific controls like `sources`, `categories`, result scraping, or scrape timeout, use `firecrawl_search` from the bundled Firecrawl plugin.

Tavily `web_search` supports `query` and `count` (up to 20 results). For Tavily-specific controls like `search_depth`, `topic`, `include_answer`, or domain filters, use `tavily_search` from the bundled Tavily plugin. For URL content extraction, use `tavily_extract`. See [Tavily](/tools/tavily) for details.

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
- If the API key is missing, `web_search` returns a short setup hint with a docs link.
