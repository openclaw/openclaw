---
summary: "Brave Search API setup for web_search"
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
title: "Brave Search"
---

# Brave Search API

OpenClaw uses Brave Search as the default provider for `web_search`.

## Get an API key

1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. In the dashboard, choose the **Search** plan and generate an API key.
3. Store the key in config (recommended) or set `BRAVE_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Notes

The Brave Search API includes $5 in free credits each month. Users may configure a $5 **usage limit** in the dashboard to avoid exceeding this amount.

See [Web tools](/tools/web) for the full web_search configuration.
