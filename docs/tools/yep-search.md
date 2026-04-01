---
summary: "Yep API setup for web_search"
read_when:
  - You want to use Yep for web_search
  - You need a YEP_API_KEY or plan details
title: "Yep"
---

# Yep

OpenClaw supports [Yep](https://yep.com) as a `web_search` provider. Yep uses an independent search index, not reliant on Google or Bing.

## Get an API key

1. Create a Yep API account at [https://platform.yep.com/](https://platform.yep.com/) — starts with 1,000 free API requests, no credit card required.
2. In the dashboard, generate an API key.
3. Store the key in config or set `YEP_API_KEY` in the Gateway environment.

## Config example

```json5
{
  plugins: {
    entries: {
      yep: {
        config: {
          webSearch: {
            apiKey: "YEP_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "yep",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

Provider-specific Yep settings live under `plugins.entries.yep.config.webSearch.*`.

## Tool parameters

| Parameter           | Description                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `query`             | Search query (required)                                                                    |
| `count`             | Number of results to return (1-10, default: 5)                                             |
| `result_type`       | Result type: `basic` (default) or `highlights` (includes text highlights from pages)       |
| `search_mode`       | `fast` or `balanced` (default). Balanced combines speed and relevance                      |
| `language`          | ISO 639-1 language code for results (e.g., "en", "de", "fr")                               |
| `content_type`      | Filter by content type (e.g., "Article", "Video", "Document", "Article/Tutorial_or_Guide") |
| `safe_search`       | Exclude adult content (default: false)                                                     |
| `include_domains`   | Comma-separated list of domains to include                                                 |
| `exclude_domains`   | Comma-separated list of domains to exclude                                                 |
| `date_after`        | Only results published after this date (YYYY-MM-DD)                                        |
| `date_before`       | Only results published before this date (YYYY-MM-DD)                                       |
| `crawl_date_after`  | Only results crawled after this date (YYYY-MM-DD)                                          |
| `crawl_date_before` | Only results crawled before this date (YYYY-MM-DD)                                         |

**Examples:**

```javascript
// Basic search
await web_search({
  query: "renewable energy",
});

// Highlights mode (includes extracted text from pages)
await web_search({
  query: "machine learning transformers",
  result_type: "highlights",
});

// Language-specific search
await web_search({
  query: "machine learning",
  language: "de",
});

// Content type filter
await web_search({
  query: "React hooks",
  content_type: "Article/Tutorial_or_Guide",
});

// Domain-filtered search
await web_search({
  query: "API design",
  include_domains: "example.com,docs.example.com",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## Notes

- Yep uses an independent web index for results.
- Pricing: basic searches cost $0.004 per call; highlights cost ~$0.009 per 10 results. See [platform.yep.com](https://platform.yep.com/#pricing) for current pricing.
- Rate limits: 60 requests/minute, 3,600/hour, 86,400/day per API key.
- Results are cached for 15 minutes by default.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with country/language filters
- [Exa Search](/tools/exa-search) -- neural search with content extraction
