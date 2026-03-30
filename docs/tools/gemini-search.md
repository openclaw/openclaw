---
summary: "Gemini web search with Google Search grounding"
read_when:
  - You want to use Gemini for web_search
  - You need a GEMINI_API_KEY
  - You want Google Search grounding
title: "Gemini Search"
---

# Gemini Search

OpenClaw supports Gemini models with built-in
[Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding),
which returns AI-synthesized answers backed by live Google Search results with
citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Go to [Google AI Studio](https://aistudio.google.com/apikey) and create an
    API key.
  </Step>
  <Step title="Store the key">
    Set `GEMINI_API_KEY` in the Gateway environment, configure Gemini web
    search directly, or reuse `models.providers.google.apiKey` from your model
    provider config:

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
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // optional if GEMINI_API_KEY or models.providers.google.apiKey is set
            baseUrl: "https://proxy.example.com/google", // optional; falls back to models.providers.google.baseUrl
            model: "gemini-2.5-flash", // default
          },
        },
      },
    },
  },
  models: {
    providers: {
      google: {
        apiKey: "AIza...", // optional fallback for web_search and other Google features
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [],
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "gemini",
      },
    },
  },
}
```

**Environment alternative:** set `GEMINI_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

Gemini web search resolves configuration in this order:

1. `tools.web.search.gemini.*` or `plugins.entries.google.config.webSearch.*`
2. `GEMINI_API_KEY` for the API key only
3. `models.providers.google.apiKey` / `models.providers.google.baseUrl`

## How it works

Unlike traditional search providers that return a list of links and snippets,
Gemini uses Google Search grounding to produce AI-synthesized answers with
inline citations. The results include both the synthesized answer and the source
URLs.

- Citation URLs from Gemini grounding are automatically resolved from Google
  redirect URLs to direct URLs.
- Redirect resolution uses the SSRF guard path (HEAD + redirect checks +
  http/https validation) before returning the final citation URL.
- Redirect resolution uses strict SSRF defaults, so redirects to
  private/internal targets are blocked.

## Supported parameters

Gemini search supports the standard `query` and `count` parameters.
Provider-specific filters like `country`, `language`, `freshness`, and
`domain_filter` are not supported.

## Model selection

The default model is `gemini-2.5-flash` (fast and cost-effective). Any Gemini
model that supports grounding can be used via
`plugins.entries.google.config.webSearch.model`.

`models.providers.google` is used only for API key and base URL fallback. It
does not override the web search model.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with snippets
- [Perplexity Search](/tools/perplexity-search) -- structured results + content extraction
