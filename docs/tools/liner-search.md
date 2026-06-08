---
summary: "Liner Search -- source-grounded AI search results with per-result excerpts"
read_when:
  - You want to use Liner for web_search
  - You need a LINER_API_KEY
  - You want ranked web results with excerpts for AI agents
title: "Liner search"
---

OpenClaw supports [Liner](https://liner.com/) as a `web_search` provider. Liner
returns ranked, source-grounded web results with a per-result excerpt, tuned for
AI agents.

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [platform.liner.com](https://platform.liner.com) and generate an
    API key from your dashboard. New accounts include free credits to start.
  </Step>
  <Step title="Store the key">
    Set `LINER_API_KEY` in the Gateway environment, or configure via:

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
      liner: {
        config: {
          webSearch: {
            apiKey: "sk_live_...", // optional if LINER_API_KEY is set
            baseUrl: "https://platform.liner.com", // optional; OpenClaw appends /api/v1/search/web
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "liner",
      },
    },
  },
}
```

**Environment alternative:** set `LINER_API_KEY` in the Gateway environment. For
a gateway install, put it in `~/.openclaw/.env`.

## Base URL override

Set `plugins.entries.liner.config.webSearch.baseUrl` when Liner requests should
go through a compatible proxy or alternate endpoint. OpenClaw normalizes bare
hosts by prepending `https://` and appends `/api/v1/search/web` unless the path
already ends there. The resolved endpoint is included in the search cache key,
so results from different endpoints are not shared.

## Tool parameters

<ParamField path="query" type="string" required>
The search query — a natural-language question or keyword phrase.
</ParamField>

<ParamField path="count" type="number">
Results to return (1-50).
</ParamField>

## Notes

- Each result includes a `title`, `url`, and a `description` excerpt; a
  `published` date and `siteName` are included when available
- OpenClaw always forwards a resolved result count to Liner as `max_results`.
  The caller's `count` arg wins, then the top-level
  `tools.web.search.maxResults` setting, otherwise OpenClaw's generic
  `web_search` default (5). This keeps result volume consistent when switching
  between providers
- `requestId` from Liner is passed through when present
- Results are cached for 15 minutes by default (configurable via
  `cacheTtlMinutes`)

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
