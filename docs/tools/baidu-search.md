---
summary: "Baidu Search API setup for web_search"
read_when:
  - You want to use Baidu Search for web_search
  - You need a BAIDU_SEARCH_API_KEY
title: "Baidu Search"
sidebarTitle: "Baidu Search"
---

# Baidu Search

OpenClaw supports Baidu Search API as a `web_search` provider.

## Get an API key

1. Go to the [Baidu AI console](https://console.bce.baidu.com/ai-search/qianfan/ais/console/apiKey)
2. Click "Create API Key" → "Create" to generate your key

## Configure

<Tabs>
  <Tab title="Config file">
    Set the key directly:

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
    }
    ```

  </Tab>
  <Tab title="Environment variable">
    Set the env var in the Gateway process environment:

    ```bash
    export BAIDU_SEARCH_API_KEY="YOUR_KEY"
    ```

    For a gateway install, put it in `~/.openclaw/.env`.
    See [Env vars](/help/faq#env-vars-and-env-loading).

  </Tab>
</Tabs>

Then configure the provider:

```json5
{
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

| Parameter     | Description                                          |
| ------------- | ---------------------------------------------------- |
| `query`       | Search query (required)                              |
| `count`       | Number of results to return (1-50, default: 10)      |
| `date_after`  | Only results published after this date (YYYY-MM-DD)  |
| `date_before` | Only results published before this date (YYYY-MM-DD) |

## Notes

- Baidu Search supports Chinese language search results
- No additional filters or options are currently supported

## Related

- [Web Search](/tools/web) -- provider comparison and auto-detection
