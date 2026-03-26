---
summary: "web_search tool -- search the web with Brave, Firecrawl, Gemini, Grok, Kimi, Perplexity, or Tavily"
read_when:
  - You want to enable or configure web_search
  - You need to choose a search provider
  - You want to understand auto-detection and provider fallback
title: "Web Search"
sidebarTitle: "Web Search"
---

# Web Search

The `web_search` tool searches the web using your configured provider and
returns results. Results are cached by query for 15 minutes (configurable).

<Info>
  `web_search` is a lightweight HTTP tool, not browser automation. For
  JS-heavy sites or logins, use the [Web Browser](/tools/browser). For
  fetching a specific URL, use [Web Fetch](/tools/web-fetch).
</Info>

## Quick start

<Steps>
  <Step title="Get an API key">
    Pick a provider and get an API key. See the provider pages below for
    sign-up links.
  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    ```
    This stores the key and sets the provider. You can also set an env var
    (e.g. `BRAVE_API_KEY`) and skip this step.
  </Step>
  <Step title="Use it">
    The agent can now call `web_search`:

    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

  </Step>
</Steps>

## Choosing a provider

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    Structured results with snippets. Supports `llm-context` mode, country/language filters. Free tier available.
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    Key-free fallback. No API key needed. Unofficial HTML-based integration.
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    Neural + keyword search with content extraction (highlights, text, summaries).
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    Structured results. Best paired with `firecrawl_search` and `firecrawl_scrape` for deep extraction.
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    AI-synthesized answers with citations via Google Search grounding.
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    AI-synthesized answers with citations via xAI web grounding.
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    Grounded answer-first responses with citations via Moonshot web search.
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    Native Search API results, or synthesized Sonar/OpenRouter answers in compatibility mode.
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    Structured results with search depth, topic filtering, and `tavily_extract` for URL extraction.
  </Card>
</CardGroup>

### Provider comparison

| Provider                               | Output style                              | Filters                                                                  | Best for                                           | API key                                     |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------- |
| [Brave](/tools/brave-search)           | Structured result list                    | Country, language, time, `llm-context` mode                              | Discovery, filtering, search-engine style results  | `BRAVE_API_KEY`                             |
| [DuckDuckGo](/tools/duckduckgo-search) | Structured result list                    | --                                                                       | Key-free fallback                                  | None (key-free)                             |
| [Exa](/tools/exa-search)               | Structured results + extracted content    | Neural/keyword mode, date, content extraction                            | Research-heavy search with summaries/highlights    | `EXA_API_KEY`                               |
| [Firecrawl](/tools/firecrawl)          | Structured result list                    | Via `firecrawl_search` tool                                              | Search paired with scraping/extraction workflows   | `FIRECRAWL_API_KEY`                         |
| [Gemini](/tools/gemini-search)         | Grounded answer + citations               | `query`, `count`                                                         | Answer-first search with Google grounding          | `GEMINI_API_KEY`                            |
| [Grok](/tools/grok-search)             | Grounded answer + citations               | `query`, `count`                                                         | Answer-first search with xAI grounding             | `XAI_API_KEY`                               |
| [Kimi](/tools/kimi-search)             | Grounded answer + citations               | `query`, `count`                                                         | Answer-first search via Moonshot grounding         | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| [Perplexity](/tools/perplexity-search) | Structured Search API or synthesized chat | Country/language/time/domains/content limits on Search API path only     | Native Search API results or Sonar compatibility   | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| [Tavily](/tools/tavily)                | Structured result list                    | Via `tavily_search` tool                                                 | Search with Tavily-specific extraction             | `TAVILY_API_KEY`                            |

<Note>
  Providers are not interchangeable even though they share the same
  `web_search` tool surface. If you need a traditional result list or
  country/language filtering, prefer Brave or native Perplexity Search API.
  If you want a grounded answer with citations, prefer Gemini, Grok, or Kimi.
</Note>

## Auto-detection

Provider lists in docs and setup flows are alphabetical. Auto-detection keeps a
separate precedence order:

If no `provider` is set, OpenClaw checks for API keys in this order and uses
the first one found:

1. **Brave** -- `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey`
2. **Gemini** -- `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey`
3. **Grok** -- `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey`
4. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` or `plugins.entries.moonshot.config.webSearch.apiKey`
5. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` or `plugins.entries.perplexity.config.webSearch.apiKey`
6. **Firecrawl** -- `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
7. **Tavily** -- `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey`

If no keys are found, it falls back to Brave (you will get a missing-key error
prompting you to configure one).

<Note>
  All provider key fields support SecretRef objects. In auto-detect mode,
  OpenClaw resolves only the selected provider key -- non-selected SecretRefs
  stay inactive.
</Note>

## Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true, // default: true
        provider: "brave", // or omit for auto-detection
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

Provider-specific config (API keys, base URLs, modes) lives under
`plugins.entries.<plugin>.config.webSearch.*`. See the provider pages for
examples.

### Storing API keys

<Tabs>
  <Tab title="Config file">
    Run `openclaw configure --section web` or set the key directly:

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "YOUR_KEY", // pragma: allowlist secret
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="Environment variable">
    Set the provider env var in the Gateway process environment:

    ```bash
    export BRAVE_API_KEY="YOUR_KEY"
    ```

    For a gateway install, put it in `~/.openclaw/.env`.
    See [Env vars](/help/faq#env-vars-and-env-loading).

  </Tab>
</Tabs>

## Tool parameters

| Parameter             | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `query`               | Search query (required)                               |
| `count`               | Results to return (1-10, default: 5)                  |
| `country`             | 2-letter ISO country code (e.g. "US", "DE")           |
| `language`            | ISO 639-1 language code (e.g. "en", "de")             |
| `freshness`           | Time filter: `day`, `week`, `month`, or `year`        |
| `date_after`          | Results after this date (YYYY-MM-DD)                  |
| `date_before`         | Results before this date (YYYY-MM-DD)                 |
| `ui_lang`             | UI language code (Brave only)                         |
| `domain_filter`       | Domain allowlist/denylist array (Perplexity only)     |
| `max_tokens`          | Total content budget, default 25000 (Perplexity only) |
| `max_tokens_per_page` | Per-page token limit, default 2048 (Perplexity only)  |

<Warning>
  Not all parameters work with all providers. Brave `llm-context` mode
  rejects `ui_lang`, `freshness`, `date_after`, and `date_before`.
  Gemini, Grok, and Kimi are answer-first providers and only support `query`
  and `count`.
  Firecrawl and Tavily only support `query` and `count` through `web_search`
  -- use their dedicated tools for advanced options.
</Warning>

## Examples

```javascript
// Basic search
await web_search({ query: "OpenClaw plugin SDK" });

// German-specific search
await web_search({ query: "TV online schauen", country: "DE", language: "de" });

// Recent results (past week)
await web_search({ query: "AI developments", freshness: "week" });

// Date range
await web_search({
  query: "climate research",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Domain filtering (Perplexity only)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

## Tool profiles

If you use tool profiles or allowlists, add `web_search` or `group:web`:

```json5
{
  tools: {
    allow: ["web_search"],
    // or: allow: ["group:web"]  (includes both web_search and web_fetch)
  },
}
```

## Related

- [Web Fetch](/tools/web-fetch) -- fetch a URL and extract readable content
- [Web Browser](/tools/browser) -- full browser automation for JS-heavy sites
