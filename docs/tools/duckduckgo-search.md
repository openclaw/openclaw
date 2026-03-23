---
summary: "DuckDuckGo web search -- key-free fallback provider (unofficial, HTML-based)"
read_when:
  - You want a web search provider that requires no API key
  - You want to use DuckDuckGo for web_search
  - You need a zero-config search fallback
title: "DuckDuckGo Search"
---

# DuckDuckGo Search

OpenClaw supports DuckDuckGo as a **key-free** `web_search` provider. No API
key or account is required.

<Warning>
  DuckDuckGo is an **unofficial, HTML-based** integration, not an official API.
  Expect occasional breakage from bot-challenge pages or HTML changes. Use it
  as a convenient fallback, not a production-grade provider.
</Warning>

## Setup

No API key needed. Set DuckDuckGo as your provider:

<Steps>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    # Select "duckduckgo" as the provider
    ```
  </Step>
</Steps>

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
      },
    },
  },
}
```

No `plugins.entries` config is needed — DuckDuckGo has no API key or
plugin-specific settings.

## Tool parameters

| Parameter | Description                    |
| --------- | ------------------------------ |
| `query`   | Search query (required)        |
| `count`   | Results to return (default: 5) |

DuckDuckGo does not support provider-specific filters like `country`,
`language`, `freshness`, or `domain_filter`.

## Notes

- **No API key** — works out of the box, zero configuration
- **Unofficial** — scrapes DuckDuckGo's non-JavaScript search pages, not an
  official API or SDK
- **Bot-challenge risk** — DuckDuckGo may serve CAPTCHAs or block requests
  under heavy or automated use
- **HTML parsing** — results depend on page structure, which can change without
  notice
- **Best-effort reliability** — treat as a fallback for development, demos, or
  environments where no API key is available

<Tip>
  For production use, consider [Brave Search](/tools/brave-search) (free tier
  available) or another API-backed provider.
</Tip>

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with free tier
- [Exa Search](/tools/exa-search) -- neural search with content extraction
