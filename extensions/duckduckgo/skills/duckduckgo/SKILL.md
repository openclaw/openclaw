---
name: duckduckgo
description: DuckDuckGo web search — free, no API key required.
metadata: { "openclaw": { "emoji": "🦆" } }
---

# DuckDuckGo Search

## When to use which tool

| Need                           | Tool                | When                                     |
| ------------------------------ | ------------------- | ---------------------------------------- |
| Quick web search               | `web_search`        | Basic queries, no special options needed |
| DuckDuckGo with region control | `duckduckgo_search` | Need region-specific localized results   |

## web_search

DuckDuckGo powers this automatically when selected as the search provider. Use
for straightforward queries.

| Parameter | Description              |
| --------- | ------------------------ |
| `query`   | Search query string      |
| `count`   | Number of results (1-25) |

## duckduckgo_search

Use when you need region-specific results.

| Parameter     | Description                                              |
| ------------- | -------------------------------------------------------- |
| `query`       | Search query string                                      |
| `max_results` | Number of results, 1-25 (default: 5)                     |
| `region`      | DuckDuckGo region code (e.g., `us-en`, `br-pt`, `de-de`) |

### Region codes

| Code    | Region         |
| ------- | -------------- |
| `us-en` | United States  |
| `uk-en` | United Kingdom |
| `br-pt` | Brazil         |
| `de-de` | Germany        |
| `fr-fr` | France         |
| `es-es` | Spain          |
| `jp-jp` | Japan          |
| `au-en` | Australia      |

Leave empty for international (unfiltered) results.

### Tips

- **No API key needed** — DuckDuckGo is free and open.
- **Keep queries concise** — search terms, not full sentences.
- **Use `region`** for localized results in a specific language/country.
- **Break complex queries into sub-queries** for better results.

## Choosing the right workflow

1. **`web_search`** — Quick lookup, no special options needed.
2. **`duckduckgo_search`** — Need region-specific results.
