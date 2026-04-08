---
summary: "Serper (Google Search API) setup for web_search"
read_when:
  - You want to use Serper for web_search
  - You need a SERPER_API_KEY or plan details
title: "Serper (Google Search)"
---

# Serper (Google Search API)

OpenClaw supports Serper as a `web_search` provider. Serper is a fast, low-cost
Google Search API that returns structured Google Search results (titles, URLs, snippets).

## Get an API key

1. Create a Serper account at [https://serper.dev/](https://serper.dev/)
2. Generate an API key from the dashboard.
3. Store the key in config or set `SERPER_API_KEY` in the Gateway environment.

<Info>
  Serper offers a free tier with 2,500 queries. See the
  [Serper pricing page](https://serper.dev/pricing) for paid plans.
</Info>

## Config example

```json5
{
  plugins: {
    entries: {
      serper: {
        config: {
          webSearch: {
            apiKey: "SERPER_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "serper",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Tool parameters

| Parameter  | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `query`    | Search query (required)                                          |
| `count`    | Number of results to return (1-10, default: 5)                   |
| `country`  | 2-letter country code for region-specific results (maps to `gl`) |
| `language` | ISO language code for search results (maps to `hl`)              |

**Examples:**

```javascript
// Basic Google search
await web_search({ query: "OpenClaw plugin SDK" });

// Country and language-specific search
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});
```

## Notes

- Serper returns real Google Search results (organic results with title, URL, and snippet).
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).
- Serper does not support `freshness`, `date_after`, `date_before`, or `ui_lang` filters. Use Brave or Perplexity if you need time-based filtering.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with time and language filters
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
