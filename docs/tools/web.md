---
summary: "Web search + fetch tools (Brave, Perplexity, Grok, SearXNG, xAI native search + code exec)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Brave Search API key setup
  - You want to use Perplexity Sonar for web search
  - You want to use Grok web search via xAI
  - You want to search X/Twitter posts or execute Python via xAI native tools
  - You want a self-hosted search engine (SearXNG)
title: "Web Tools"
---

# Web tools

OpenClaw ships lightweight web and search tools:

- `web_search` — Search the web via Brave, Perplexity Sonar, Grok, or SearXNG.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).
- `xai_search` — Search X (Twitter) posts via xAI's native `x_search` tool.
- `xai_code_exec` — Execute Python code in xAI's remote sandbox via `code_exec_python`.

`web_search` and `web_fetch` are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## web_search

Search the web using your configured provider.

### How it works

- Calls your chosen provider and returns results.
  - **Brave** (default): structured results (title, URL, snippet).
  - **Perplexity**: AI-synthesized answers with citations from real-time web search.
  - **Grok**: xAI-powered web search using `OPENAI_RESPONSE_FORMAT` compatible completions.
  - **SearXNG**: self-hosted meta-search engine (privacy-friendly, no API key needed).
- Results are cached by query for 15 minutes (configurable).

### Choosing a search provider

| Provider            | Pros                                         | Cons                                      | Key / Config                                       |
| ------------------- | -------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| **Brave** (default) | Fast, structured results, free tier          | Traditional results (no AI synthesis)     | `BRAVE_API_KEY`                                    |
| **Perplexity**      | AI-synthesized answers, citations, real-time | Requires Perplexity or OpenRouter account | `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY`       |
| **Grok**            | xAI-powered synthesis, X/web context         | Requires xAI API key                      | `XAI_API_KEY` or `tools.web.search.grok.apiKey`    |
| **SearXNG**         | Self-hosted, privacy-preserving, no API key  | Requires running a SearXNG instance       | `SEARXNG_BASE_URL` or `tools.web.search.searxng.*` |

See [Brave Search](/brave-search) and [Perplexity Sonar](/perplexity) for provider-specific details.

### Auto-detection

If no `provider` is set, OpenClaw picks the first provider with a working key/URL:

1. **Brave** — `BRAVE_API_KEY` or `tools.web.search.apiKey`
2. **Perplexity** — `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` or `tools.web.search.perplexity.apiKey`
3. **Grok** — `XAI_API_KEY` or `tools.web.search.grok.apiKey`
4. **SearXNG** — `SEARXNG_BASE_URL` or `tools.web.search.searxng.baseUrl`

If no keys or URLs are found, it falls back to Brave (you'll get a missing-key error prompting
you to configure one).

### Explicit provider

Set the provider in config:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // "brave" | "perplexity" | "grok" | "searxng"
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

### web_search requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider (see table above)

### web_search config

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

### web_search tool parameters

- `query` (required)
- `count` (1–10; default from config)
- `country` (optional): 2-letter country code for region-specific results (e.g., `"DE"`, `"US"`, `"ALL"`)
- `search_lang` (optional): ISO language code for search results (e.g., `"de"`, `"en"`, `"fr"`)
- `ui_lang` (optional): ISO language code for UI elements
- `freshness` (optional): filter by discovery time
  - Brave: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`
  - Perplexity: `pd`, `pw`, `pm`, `py`

**Examples:**

```javascript
// German-specific search
await web_search({ query: "TV online schauen", count: 10, country: "DE", search_lang: "de" });

// Recent results (past week)
await web_search({ query: "TMBG interview", freshness: "pw" });
```

---

## Brave Search setup

1. Create an account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. Choose the **Data for Search** plan and generate an API key (not "Data for AI").
3. Store it with `openclaw configure --section web`, or set `BRAVE_API_KEY` in the Gateway environment.

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

See [Brave Search](/brave-search) for details.

---

## Perplexity setup

Perplexity Sonar models have built-in web search with AI-synthesized answers and citations.
Use via OpenRouter (prepaid/crypto) or Perplexity's direct API.

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "sk-or-v1-...", // OPENROUTER_API_KEY or PERPLEXITY_API_KEY
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro", // default
        },
      },
    },
  },
}
```

If no `baseUrl` is set, OpenClaw picks a default based on key prefix:

- `PERPLEXITY_API_KEY` / `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` / `sk-or-...` → `https://openrouter.ai/api/v1`

| Model                            | Description                       | Best for          |
| -------------------------------- | --------------------------------- | ----------------- |
| `perplexity/sonar`               | Fast Q&A with web search          | Quick lookups     |
| `perplexity/sonar-pro` (default) | Multi-step reasoning + web search | Complex questions |
| `perplexity/sonar-reasoning-pro` | Chain-of-thought analysis         | Deep research     |

See [Perplexity Sonar](/perplexity) for details.

---

## Grok search setup

[xAI Grok](https://x.ai/) models can search the web and surface results with inline citations.
Requires an xAI API key.

```json5
{
  tools: {
    web: {
      search: {
        provider: "grok",
        grok: {
          apiKey: "xai-...", // optional if XAI_API_KEY is set
          model: "grok-4", // default
          inlineCitations: false, // include citation URLs inline
        },
      },
    },
  },
}
```

**Environment alternative:** set `XAI_API_KEY` in the Gateway environment (`~/.openclaw/.env`).

> **Note:** This is the `web_search` Grok provider, which searches the web. For searching
> X/Twitter posts or running Python in xAI's sandbox, see [xai_search](#xai_search) and
> [xai_code_exec](#xai_code_exec) below.

---

## SearXNG setup

[SearXNG](https://docs.searxng.org/) is a self-hosted, privacy-preserving meta-search engine.
No API key is required — just point OpenClaw at your SearXNG instance's base URL.

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
        searxng: {
          baseUrl: "https://search.example.com", // required
          timeoutSeconds: 30,
        },
      },
    },
  },
}
```

**Environment alternative:** set `SEARXNG_BASE_URL` in the Gateway environment.

---

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
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // 1 day
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

- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured).
- Firecrawl requests use bot-circumvention mode and cache results by default.
- Sends a Chrome-like User-Agent by default; override `userAgent` if needed.
- Blocks private/internal hostnames and re-checks redirects.
- `maxChars` is clamped to `tools.web.fetch.maxCharsCap`.
- Response body is capped to `maxResponseBytes` before parsing; oversized responses are truncated.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes).
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.

---

## xai_search

Search X (Twitter) posts using xAI's native `x_search` tool. This is a separate tool from
`web_search` — it targets posts on X/Twitter, not general web results.

### xai_search requirements

- `XAI_API_KEY` env var, or `tools.xai.apiKey` in config
- `tools.xai.search.enabled` must not be `false` (default: enabled when key is present)

### xai_search config

```json5
{
  tools: {
    xai: {
      apiKey: "xai-...", // optional if XAI_API_KEY is set
      model: "grok-4", // default
      search: {
        enabled: true,
      },
    },
  },
}
```

### xai_search tool parameters

- `query` (required): search query or topic
- `count` (optional, default 10): number of posts to return

### xai_search example

```javascript
await xai_search({ query: "OpenAI GPT-5 launch", count: 10 });
```

Results include post text, author handles, and dates. Content is marked as external/untrusted
in the agent context.

---

## xai_code_exec

Execute Python code in xAI's remote sandbox using the native `code_exec_python` tool.
Useful for data analysis, calculations, and scripted tasks that need a live Python runtime.

### xai_code_exec requirements

- `XAI_API_KEY` env var, or `tools.xai.apiKey` in config
- `tools.xai.codeExec.enabled` must not be `false` (default: enabled when key is present)

### xai_code_exec config

```json5
{
  tools: {
    xai: {
      apiKey: "xai-...", // optional if XAI_API_KEY is set
      model: "grok-4", // default
      codeExec: {
        enabled: true,
      },
    },
  },
}
```

### xai_code_exec tool parameters

- `task` (required): description of what to compute or accomplish
- `hint` (optional): extra context or code to start from

### xai_code_exec example

```javascript
await xai_code_exec({
  task: "Calculate the Fibonacci sequence up to 1000 and return the values as JSON",
});
```

The tool returns stdout output and/or structured results from the sandbox. Execution is
stateless — each call is an isolated run.

---

## General notes

- If you use tool profiles/allowlists, add `xai_search`/`xai_code_exec` to the allow list or use `group:plugins`.
- `XAI_API_KEY` is shared by the `grok` web search provider, `xai_search`, and `xai_code_exec` — one key enables all three.
- All results from external sources are security-marked as untrusted content in the agent context.
