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
  DuckDuckGo is an **unofficial, HTML-based** integration. It scrapes
  DuckDuckGo's non-JavaScript search pages, not an official API or SDK.
  Expect occasional breakage from bot-challenge pages or HTML changes.
  Use it as a convenient fallback, not a production-grade provider.
</Warning>

## Quick start

DuckDuckGo requires no API key. Just set it as your provider:

```bash
openclaw configure --section web
# Select "duckduckgo" as the provider
```

Or set the provider directly in config:

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

That's it — no keys, no plugin config, no environment variables.

## How it works

Unlike API-backed providers (Brave, Perplexity, Tavily), DuckDuckGo search
works by:

1. Sending an HTTP request to DuckDuckGo's non-JavaScript search endpoint
2. Parsing the HTML response to extract search results
3. Returning structured results with titles, URLs, and snippets

This approach means:

- **No API key needed** — works out of the box
- **No rate limits from an API plan** — but DuckDuckGo may serve bot-challenge
  pages under heavy use
- **Results may differ** from what you see in DuckDuckGo's full web interface

## Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "duckduckgo",
      },
    },
  },
}
```

No `plugins.entries` config is needed — DuckDuckGo has no API key or plugin-specific settings.

## Supported parameters

DuckDuckGo search supports the standard `query` and `count` parameters.
Provider-specific filters like `country`, `language`, `freshness`, and
`domain_filter` are not supported.

## Limitations

- **Unofficial integration** — not backed by a DuckDuckGo API or SDK
- **Bot-challenge risk** — DuckDuckGo may serve CAPTCHAs or block requests
  under heavy or automated use
- **HTML parsing** — results depend on DuckDuckGo's page structure, which can
  change without notice
- **No advanced filters** — only `query` and `count` are supported
- **Best-effort reliability** — treat this as a fallback, not a primary
  provider for production use

## When to use DuckDuckGo

<CardGroup cols={2}>
  <Card title="Good for" icon="check">
    Quick local development, demos, testing, or environments where no API key
    is available
  </Card>
  <Card title="Not recommended for" icon="x">
    Production gateways, high-volume search, or workflows requiring reliable
    uptime
  </Card>
</CardGroup>

For production use, consider [Brave Search](/tools/brave-search) (free tier
available) or another API-backed provider.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with free tier
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers (also no search-specific key if you have a Gemini key)
