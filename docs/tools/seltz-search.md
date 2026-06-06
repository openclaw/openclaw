---
summary: "Seltz search -- context-engineered web documents for AI reasoning"
read_when:
  - You want to use Seltz for web_search
  - You need a SELTZ_API_KEY
  - You want context-engineered web documents for AI agents
title: "Seltz search"
---

OpenClaw supports [Seltz](https://seltz.ai/) as a `web_search` provider.
Seltz returns source-backed web documents shaped for AI reasoning.

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [seltz.ai](https://seltz.ai/) or open the
    [Seltz console](https://console.seltz.ai), then generate an API key.
  </Step>
  <Step title="Store the key">
    Set `SELTZ_API_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Config

```json5
{
  plugins: {
    entries: {
      seltz: {
        config: {
          webSearch: {
            apiKey: "your-api-key", // optional if SELTZ_API_KEY is set
            baseUrl: "https://api.seltz.ai", // optional; OpenClaw appends /v1/search
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "seltz",
      },
    },
  },
}
```

**Environment alternative:** set `SELTZ_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## Base URL override

Set `plugins.entries.seltz.config.webSearch.baseUrl` when Seltz search
requests should go through a compatible proxy or alternate Seltz endpoint.
OpenClaw normalizes bare hosts by prepending `https://` and appends
`/v1/search` unless the path already ends there. The resolved endpoint is
included in the search cache key, so results from different Seltz endpoints are
not shared.

## Tool parameters

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number">
Results to return (1-10).
</ParamField>

## Notes

- OpenClaw calls Seltz's `POST /v1/search` endpoint with `query` and
  `max_results`
- Result documents are returned as `results[]` with source URLs and wrapped
  document content in `description`
- OpenClaw sends an explicit result count so Seltz uses the same default result
  volume as the generic `web_search` tool: 5 results unless overridden
- Results are cached for 15 minutes by default (configurable via
  `cacheTtlMinutes`)

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Parallel search](/tools/parallel-search) -- dense excerpts ranked for LLM context
