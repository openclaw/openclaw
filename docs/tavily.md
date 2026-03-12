---
summary: "Tavily Search API setup for web_search"
read_when:
  - You want to use Tavily Search for web search
  - You need a TAVILY_API_KEY setup
title: "Tavily Search"
---

# Tavily Search API

OpenClaw supports Tavily as a `web_search` provider.
It returns structured results with `title`, `url`, and `snippet` fields,
with optional AI-generated answer summaries and configurable search depth.

## Getting a Tavily API key

1. Create a Tavily account at [app.tavily.com](https://app.tavily.com/)
2. Generate an API key in the dashboard
3. Store the key in config or set `TAVILY_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "tavily",
        tavily: {
          apiKey: "tvly-...", // optional if TAVILY_API_KEY is set
        },
      },
    },
  },
}
```

## Where to set the key

**Via config:** run `openclaw configure --section web`. It stores the key in
`~/.openclaw/openclaw.json` under `tools.web.search.tavily.apiKey`.
That field also accepts SecretRef objects.

**Via environment:** set `TAVILY_API_KEY`
in the Gateway process environment. For a gateway install, put it in
`~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

If `provider: "tavily"` is configured and the Tavily key SecretRef is unresolved with no env fallback, startup/reload fails fast.

## Tool parameters

| Parameter        | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `query`          | Search query (required)                                |
| `count`          | Number of results to return (1-20, default: 5)         |
| `freshness`      | Time filter: `day` (24h), `week`, `month`, or `year`   |
| `date_after`     | Only results published after this date (YYYY-MM-DD)    |
| `date_before`    | Only results published before this date (YYYY-MM-DD)   |
| `search_depth`   | Search depth: `basic` or `advanced` (default: `basic`) |
| `include_answer` | Include AI-generated answer summary (boolean)          |
| `domain_filter`  | Domain allowlist/denylist array (max 20)               |

**Examples:**

```javascript
// Basic search
await web_search({
  query: "renewable energy trends",
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "week",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Advanced search with AI answer
await web_search({
  query: "climate change effects",
  search_depth: "advanced",
  include_answer: true,
});

// Domain filtering (allowlist)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Exclude domains (denylist - prefix with -)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

### Domain filter rules

- Maximum 20 domains per filter
- Cannot mix allowlist and denylist in the same request
- Use `-` prefix for denylist entries (e.g., `["-reddit.com"]`)

## Notes

- Tavily returns structured web search results (`title`, `url`, `snippet`).
- `search_depth: "advanced"` performs a more thorough search at the cost of slightly higher latency.
- `include_answer: true` appends an AI-generated summary alongside the structured results.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

See [Web tools](/tools/web) for the full web_search configuration.
See [Tavily API Docs](https://docs.tavily.com) for more details.
