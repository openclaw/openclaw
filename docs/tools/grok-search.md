---
summary: "Grok web search via xAI web-grounded responses"
read_when:
  - You want to use Grok for web_search
  - You need an XAI_API_KEY for web search
title: "Grok Search"
---

# Grok Search

OpenClaw supports Grok as a `web_search` provider, using xAI web-grounded
responses to produce AI-synthesized answers backed by live search results
with citations.

The same `XAI_API_KEY` can also power the built-in `x_search` tool for X
(formerly Twitter) post search. If you store the key under
`plugins.entries.xai.config.webSearch.apiKey`, OpenClaw now reuses it as a
fallback for the bundled xAI model provider too.

## Get an API key

<Steps>
  <Step title="Create a key">
    Get an API key from [xAI](https://console.x.ai/).
  </Step>
  <Step title="Store the key">
    Set `XAI_API_KEY` in the Gateway environment, or configure via:

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
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...", // optional if XAI_API_KEY is set
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "grok",
      },
    },
  },
}
```

**Environment alternative:** set `XAI_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## How it works

Grok uses xAI web-grounded responses to synthesize answers with inline
citations, similar to Gemini's Google Search grounding approach.

## Supported parameters

Grok search supports the standard `query` and `count` parameters.
Provider-specific filters are not currently supported.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [x_search in Web Search](/tools/web#x_search) -- first-class X search via xAI
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
