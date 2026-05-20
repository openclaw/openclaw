---
summary: "Apify web search and web fetch providers"
read_when:
  - You want to use Apify as a web_search or web_fetch provider
  - You need full-page content extraction with JS rendering
  - You want to configure the Apify crawler type or timeout
title: "Apify"
---

OpenClaw can use **Apify** in two ways:

- as the `web_search` provider (via the [RAG Web Browser](https://apify.com/apify/rag-web-browser) actor)
- as the `web_fetch` provider (via the [Website Content Crawler](https://apify.com/apify/website-content-crawler) actor)

Both share a single API key stored at `plugins.entries.apify.config.apiKey`.

## Get an API key

1. Create a free [Apify](https://apify.com/) account.
2. Copy your API token from [Apify Console](https://console.apify.com/settings/integrations).
3. Store it in config or set `APIFY_API_KEY` in the gateway environment.

## Configure Apify web search

```json5
{
  tools: {
    web: {
      search: {
        provider: "apify",
      },
    },
  },
  plugins: {
    entries: {
      apify: {
        enabled: true,
        config: {
          apiKey: "apify_...",
          webSearch: {
            maxResults: 5, // 1–10, default: 5
            timeoutSeconds: 30, // 1–300, default: 30
          },
        },
      },
    },
  },
}
```

The [RAG Web Browser](https://apify.com/apify/rag-web-browser) Actor returns headless-rendered pages with full Markdown content, providing full context and formatting even from dynamic web pages.

## Configure Apify web fetch

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "apify",
        readability: false, // skip local extraction and go straight to Apify
      },
    },
  },
  plugins: {
    entries: {
      apify: {
        enabled: true,
        config: {
          apiKey: "apify_...",
          webFetch: {
            crawlerType: "playwright:adaptive", // "playwright:adaptive" | "playwright:firefox" | "cheerio"
            timeoutSeconds: 60, // 1–300, default: 60
          },
        },
      },
    },
  },
}
```

### Crawler types

| Crawler                         | Best for                                | Memory |
| ------------------------------- | --------------------------------------- | ------ |
| `playwright:adaptive` (default) | Auto-selects headless vs full rendering | 4 GB   |
| `playwright:firefox`            | JS-heavy or bot-protected pages         | 4 GB   |
| `cheerio`                       | Fast plain-HTML pages                   | 1 GB   |

Use `playwright:firefox` when `playwright:adaptive` returns empty or partial content.

Setting `tools.web.fetch.readability: false` skips the local Readability extraction
step and routes all `web_fetch` calls directly to the Apify actor.

## Notes

- `plugins.entries.apify.config.apiKey` is the shared key for both providers. The env fallback is `APIFY_API_KEY`.
- Actor memory is chosen automatically: 1 GB for Cheerio raw HTTP requests, 4 GB for Playwright browser.
- Results from the RAG Web Browser are cached for 15 minutes (controlled by `tools.web.search.cacheTtlMinutes`).
- Use [Apify OpenClaw plugin](https://docs.apify.com/platform/integrations/openclaw) to let your claws access thousands of other web data extraction and automation tools from [Apify Store](https://apify.com/store)

## Related

- [Web Search](/tools/web) -- all providers and auto-detection
- [Web Fetch](/tools/web-fetch) -- `web_fetch` tool and provider configuration
- [Firecrawl](/tools/firecrawl) -- alternative web fetch and search provider
