---
summary: "Bocha Web Search API setup for web_search"
read_when:
  - You want to use Bocha Web Search for web_search
  - You need a BOCHA_API_KEY or plan details
title: "Bocha Web Search"
---

# Bocha Web Search API

OpenClaw supports Bocha Web Search API as a `web_search` provider. It provides high-quality web search results, especially optimized for Chinese content.

## Get an API key

1. Create a Bocha API account at [https://open.bocha.cn/](https://open.bocha.cn/)
2. Generate an API key in the developer dashboard.
3. Store the key in config or set `BOCHA_API_KEY` in the Gateway environment.

## Config example

```json5
{
  plugins: {
    entries: {
      bocha: {
        config: {
          webSearch: {
            apiKey: "BOCHA_API_KEY_HERE",
            baseUrl: "https://api.bocha.cn/v1", // Optional override
            summary: true, // Whether to return original web content
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "bocha",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

Provider-specific Bocha search settings live under `plugins.entries.bocha.config.webSearch.*`.

## Tool parameters

| Parameter   | Description                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| `query`     | Search query (required)                                                         |
| `count`     | Number of results to return (1-10, default: 5)                                  |
| `freshness` | Time filter: `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, or `noLimit` (default) |
| `summary`   | Whether to return the original web content (default: true)                      |

**Examples:**

```javascript
// Basic search
await web_search({
  query: "OpenClaw AI",
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "oneWeek",
});

// Search without full content summary
await web_search({
  query: "latest technology",
  summary: false,
});
```

## Notes

- Bocha is highly recommended for users who need high-quality search results in Chinese.
- The `summary` parameter, when enabled, provides richer content for the AI to process, but may increase token usage.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with country/language filters
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
