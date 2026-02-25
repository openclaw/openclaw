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
2. In the dashboard, choose the **Data for Search** plan and generate an API key.
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

- The Data for AI plan is **not** compatible with `web_search`.
- Brave provides paid plans; check the Brave API portal for current limits.
- Brave limits the use for AI, ruling out the "use the Search Results to create, evaluate, train, re-train, fine-tune, benchmark or otherwise improve artificial intelligence models or services offered by Customer or third parties". As long as you are not involved in AI model creation, don't use AI models that store usage data for improvement (e.g. many free OpenRouter models), or provide OpenClaw as a service for others, you _should_ be good. This is, however, not legal advice---Check the Terms of Service.

See [Web tools](/tools/web) for the full web_search configuration.
