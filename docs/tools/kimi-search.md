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

Unlike Brave, which typically returns structured search-style results, Kimi may
return a grounded answer synthesized from Moonshot's native `$web_search` flow.
If you need raw search-style snippets plus filters like country or language,
Brave or Perplexity are a better fit.

## Supported parameters

Kimi search supports the standard `query` and `count` parameters.
Country/language/freshness/date-style filters are provider-dependent and are
not currently supported by Kimi through `web_search`.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) -- AI-synthesized answers via xAI grounding
