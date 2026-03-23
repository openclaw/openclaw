---
summary: "web_search tool -- search the web with AI/ML API, Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, Perplexity, or Tavily"
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
    (for example `BRAVE_API_KEY`) and skip this step.
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
  <Card title="AI/ML API" icon="cpu" href="/tools/web">
    AI-synthesized answers with citations via Perplexity Sonar-compatible models.
  </Card>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    Structured results with snippets. Supports `llm-context` mode, country/language filters.
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    Key-free fallback. No API key needed. Unofficial HTML-based integration.
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    Neural + keyword search with content extraction.
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    Structured results. Best paired with `firecrawl_search` and `firecrawl_scrape`.
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    AI-synthesized answers with citations via Google Search grounding.
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    AI-synthesized answers with citations via xAI web grounding.
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    AI-synthesized answers with citations via Moonshot web search.
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    Structured results with domain filtering and content extraction controls.
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    Structured results with search depth, topic filtering, and `tavily_extract`.
  </Card>
</CardGroup>

### Provider comparison

| Provider                               | Result style               | Filters                                       | API key                                     |
| -------------------------------------- | -------------------------- | --------------------------------------------- | ------------------------------------------- |
| [AI/ML API](/tools/web)                | AI-synthesized + citations | `freshness`, date range, domains              | `AIMLAPI_API_KEY`                           |
| [Brave](/tools/brave-search)           | Structured snippets        | Country, language, time, `llm-context` mode   | `BRAVE_API_KEY`                             |
| [DuckDuckGo](/tools/duckduckgo-search) | Structured snippets        | --                                            | None (key-free)                             |
| [Exa](/tools/exa-search)               | Structured + extracted     | Neural/keyword mode, date, content extraction | `EXA_API_KEY`                               |
| [Firecrawl](/tools/firecrawl)          | Structured snippets        | Via `firecrawl_search` tool                   | `FIRECRAWL_API_KEY`                         |
| [Gemini](/tools/gemini-search)         | AI-synthesized + citations | --                                            | `GEMINI_API_KEY`                            |
| [Grok](/tools/grok-search)             | AI-synthesized + citations | --                                            | `XAI_API_KEY`                               |
| [Kimi](/tools/kimi-search)             | AI-synthesized + citations | --                                            | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| [Perplexity](/tools/perplexity-search) | Structured snippets        | Country, language, time, domains              | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| [Tavily](/tools/tavily)                | Structured snippets        | Via `tavily_search` tool                      | `TAVILY_API_KEY`                            |

## Auto-detection

Provider lists in docs and setup flows are alphabetical. Auto-detection keeps a
separate precedence order.

If no `provider` is set, OpenClaw checks for API keys in this order and uses
the first one found:

1. **Brave** -- `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey`
2. **AI/ML API** -- `AIMLAPI_API_KEY` or `plugins.entries.aimlapi.config.webSearch.apiKey`
3. **Gemini** -- `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey`
4. **Grok** -- `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey`
5. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` or `plugins.entries.moonshot.config.webSearch.apiKey`
6. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` or `plugins.entries.perplexity.config.webSearch.apiKey`
7. **Firecrawl** -- `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
8. **Tavily** -- `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey`

If no keys are found, it falls back to Brave and prompts you to configure one.

<Note>
  All provider key fields support SecretRef objects. In auto-detect mode,
  OpenClaw resolves only the selected provider key. Non-selected SecretRefs stay
  inactive.
</Note>

### AI/ML API Search

1. Create an account at [aimlapi.com](https://aimlapi.com)
2. Generate an API key in the dashboard
3. Run `openclaw configure --section web` or set `AIMLAPI_API_KEY`

For the smoothest results, keep the default model (`perplexity/sonar-pro`) or
use `perplexity/sonar`.

## web_search

Search the web using your configured provider.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider:
  - **AI/ML API**: `AIMLAPI_API_KEY` or `plugins.entries.aimlapi.config.webSearch.apiKey`
  - **Brave**: `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey`
  - **Exa**: `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey`
  - **Firecrawl**: `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
  - **Gemini**: `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey`
  - **Grok**: `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey`
  - **Kimi**: `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `plugins.entries.moonshot.config.webSearch.apiKey`
  - **Perplexity**: `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `plugins.entries.perplexity.config.webSearch.apiKey`
  - **Tavily**: `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey`
- DuckDuckGo does not require a key

## Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave", // or omit for auto-detection
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

Provider-specific config lives under
`plugins.entries.<plugin>.config.webSearch.*`.

### AI/ML API example

```json5
{
  plugins: {
    entries: {
      aimlapi: {
        config: {
          webSearch: {
            apiKey: "aiml-...",
            baseUrl: "https://api.aimlapi.com/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "aimlapi",
      },
    },
  },
}
```

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

  </Tab>
</Tabs>
