---
summary: "Baidu AppBuilder intelligent web search generation for web_search"
read_when:
  - You want to use Baidu for web_search
  - You need an APPBUILDER_API_KEY
  - You want Baidu Search grounded answers with citations
title: "Baidu Search"
---

# Baidu Search

OpenClaw supports Baidu AppBuilder as a `web_search` provider using Baidu's
intelligent search generation API. It returns AI-synthesized answers grounded
in live Baidu Search results, plus citation metadata for the referenced pages.

## Get an API key

<Steps>
  <Step title="Create a key">
    Create an AppBuilder API key in
    [Baidu AppBuilder](https://appbuilder.baidu.com/).
  </Step>
  <Step title="Store the key">
    Set `APPBUILDER_API_KEY` in the Gateway environment, or configure via:

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
      baidu: {
        config: {
          webSearch: {
            apiKey: "appbuilder_...", // optional if APPBUILDER_API_KEY is set
            model: "ernie-4.5-turbo-32k", // default
            enableDeepSearch: false, // optional
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "baidu",
      },
    },
  },
}
```

**Environment alternative:** set `APPBUILDER_API_KEY` in the Gateway
environment. `APPBUILDER_TOKEN` is also accepted as a legacy fallback. For a
gateway install, put it in `~/.openclaw/.env`.

## How it works

OpenClaw uses Baidu AppBuilder's `chat/completions` AI Search API with
`search_source: "baidu_search_v2"` so the model can synthesize an answer from
live web results.

- `count` maps to the number of grounded web references (`resource_type_filter`)
- `freshness` maps to Baidu's `search_recency_filter`
  Supported values are `week`, `month`, `semiyear`, and `year`.
- `date_after` / `date_before` map to Baidu page-time range filters
- `country` and `language` are not supported by the Baidu provider

## Supported parameters

Baidu search supports:

- `query`
- `count`
- `freshness`
- `date_after`
- `date_before`

It does not support:

- `country`
- `language`
- provider-specific options like Brave `ui_lang` or Perplexity `domain_filter`

## Model selection

The default model is `ernie-4.5-turbo-32k`. If your AppBuilder account has a
different supported search-generation model enabled, override it with
`plugins.entries.baidu.config.webSearch.model`.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
- [Kimi Search](/tools/kimi-search) -- AI-synthesized answers via Moonshot web search
