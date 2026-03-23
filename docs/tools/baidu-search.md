---
summary: "Baidu Search API setup for web_search"
read_when:
  - You want to use Baidu Search for web_search
  - You need a BAIDU_SEARCH_API_KEY
title: "Baidu Search"
---

# Brave Search API

OpenClaw supports Baidu Search API as a `web_search` provider.

## Get an API key

1. BAIDU_API_KEY retrieval URL:https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey
2. Click “Create API Key” → “Create” to generate your key.
3. Configuration Method 1:Provide the API Key directly to OpenClaw in the chat.
4. Configuration Method 2:Refer to the file references/apikey-fetch.md in the Skill project for setup instructions.

## Config example

```json5
{
  plugins: {
    entries: {
      baidu: {
        config: {
          webSearch: {
            apiKey: "BAIDU_SEARCH_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "baidu",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Tool parameters

| Parameter | Description                                     |
| --------- | ----------------------------------------------- |
| `query`   | Search query (required)                         |
| `count`   | Number of results to return (1-50, default: 10) |

## Notes
