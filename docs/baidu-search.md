---
summary: "Brave Search API setup for web_search"
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
title: "Brave Search"
---

# Baidu Search API

OpenClaw uses Baidu Search as the `web_search` tool

## Get an API key

1.  Visit the [Baidu AI Search Console](https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey)
2.  Generate a new API key or select an existing one(format: `bce-v3/ALTAK-...`)
3.  Copy the API key and use it with OpenClaw

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "baidu",
        baidu: {
          apiKey: "bce-v3/ALTAK-...",
        },
      },
    },
  },
}
```

## Notes

See [Web tools](/tools/web) for the full web_search configuration.
