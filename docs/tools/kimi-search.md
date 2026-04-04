---
summary: "Kimi web search via Moonshot web search"
read_when:
  - You want to use Kimi for web_search
  - You need a KIMI_API_KEY or MOONSHOT_API_KEY
title: "Kimi Search"
---

# Kimi Search

OpenClaw supports Kimi as a `web_search` provider, using Moonshot web search
to produce AI-synthesized answers with citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Get an API key from [Moonshot AI](https://platform.moonshot.cn/).
  </Step>
  <Step title="Store the key">
    Set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the Gateway environment, or
    configure via:

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
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // optional if KIMI_API_KEY or MOONSHOT_API_KEY is set
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

**Environment alternative:** set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the
Gateway environment. For a gateway install, put it in `~/.openclaw/.env`.

## How it works

Kimi uses Moonshot web search to synthesize answers with inline citations,
similar to Gemini and Grok's grounded response approach.

## Supported parameters

Kimi search supports the standard `query` and `count` parameters.
Provider-specific filters are not currently supported.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) -- AI-synthesized answers via xAI grounding
