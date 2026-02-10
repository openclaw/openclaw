---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Brave Search API setup for web_search"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Brave Search for web_search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a BRAVE_API_KEY or plan details（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Brave Search"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Brave Search API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses Brave Search as the default provider for `web_search`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Get an API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In the dashboard, choose the **Data for Search** plan and generate an API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Store the key in config (recommended) or set `BRAVE_API_KEY` in the Gateway environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        provider: "brave",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "BRAVE_API_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxResults: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        timeoutSeconds: 30,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Data for AI plan is **not** compatible with `web_search`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Brave provides a free tier plus paid plans; check the Brave API portal for current limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Web tools](/tools/web) for the full web_search configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
