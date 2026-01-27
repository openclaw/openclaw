---
summary: "Exa AI setup for web_search"
read_when:
  - You want to use Exa AI for web search
  - You need an EXA_API_KEY or setup details
---

# Exa AI

Moltbot can use Exa AI for the `web_search` tool. Exa is a search API
built for AI agents.

## Get an API key

1) Create an account at https://exa.ai/
2) Generate an API key at https://dashboard.exa.ai/api-keys
3) Store the key in config (recommended) or set `EXA_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "exa",
        exa: {
          apiKey: "your-exa-api-key"
        }
      }
    }
  }
}
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `contents` | Include page text in results; when false, only URLs and titles are returned | `true` |
| `maxChars` | Max characters of page text per result; higher values provide more context but use more tokens | `1500` |

See [Web tools](/tools/web) for the full web_search configuration.
