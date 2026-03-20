---
summary: "DuckDuckGo web search — free, no API key required"
read_when:
  - You want free web search without an API key
  - You want DuckDuckGo as a web_search provider
  - You want privacy-focused web search
title: "DuckDuckGo"
---

# DuckDuckGo

OpenClaw can use **DuckDuckGo** as a `web_search` provider or via the dedicated
`duckduckgo_search` plugin tool.

DuckDuckGo is a privacy-focused search engine. Unlike other providers, **no API
key is required** — making it a great default for quick setups and contributors
who don't have paid search API access.

## Configure DuckDuckGo search

```json5
{
  plugins: {
    entries: {
      duckduckgo: {
        enabled: true,
        config: {
          webSearch: {
            region: "us-en", // optional: region code for localized results
            safeSearch: "moderate", // optional: "strict", "moderate", or "off"
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
      },
    },
  },
}
```

Notes:

- **No API key needed.** DuckDuckGo is free and open.
- Choosing DuckDuckGo in onboarding or `openclaw configure --section web`
  enables the bundled DuckDuckGo plugin automatically.
- Store config under `plugins.entries.duckduckgo.config.webSearch.*`.
- `web_search` with DuckDuckGo supports `query`, `count` (up to 25 results),
  and `region`.

## DuckDuckGo plugin tool

### `duckduckgo_search`

Use this for DuckDuckGo-specific options.

| Parameter     | Description                                              |
| ------------- | -------------------------------------------------------- |
| `query`       | Search query string                                      |
| `max_results` | Number of results, 1-25 (default: 5)                     |
| `region`      | DuckDuckGo region code (e.g., `us-en`, `br-pt`, `de-de`) |

### Region codes

Common region codes:

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

## Choosing the right tool

| Need                                    | Tool                |
| --------------------------------------- | ------------------- |
| Quick web search, no API key            | `web_search`        |
| DuckDuckGo with region-specific results | `duckduckgo_search` |

See [Web tools](/tools/web) for the full web tool setup and provider comparison.
