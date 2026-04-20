---
summary: "Ollama Web Search via your configured Ollama host"
read_when:
  - You want to use Ollama for web_search
  - You want a key-free web_search provider
  - You need Ollama Web Search setup guidance
title: "Ollama Web Search"
---

# Ollama Web Search

OpenClaw supports **Ollama Web Search** as a bundled `web_search` provider.
It calls Ollama's Cloud web-search API and returns structured results with
titles, URLs, and snippets.

Ollama Web Search is a cloud capability; the local Ollama daemon does not
serve it. The provider requires:

- an Ollama account (free)
- `ollama signin` (stores the API key OpenClaw reuses for the cloud call)

## Setup

<Steps>
  <Step title="Start Ollama">
    Make sure Ollama is installed and running.
  </Step>
  <Step title="Sign in">
    Run:

    ```bash
    ollama signin
    ```

  </Step>
  <Step title="Choose Ollama Web Search">
    Run:

    ```bash
    openclaw configure --section web
    ```

    Then select **Ollama Web Search** as the provider.

  </Step>
</Steps>

If you already use Ollama for models, Ollama Web Search reuses the same
credential (`models.providers.ollama.apiKey` or `OLLAMA_API_KEY`) to call
the cloud search endpoint.

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

Optional web-search base URL override (for custom proxies that mirror the
`/api/web_search` contract):

```json5
{
  plugins: {
    entries: {
      ollama: {
        config: {
          webSearch: {
            baseUrl: "https://my-proxy.example.com",
          },
        },
      },
    },
  },
}
```

If no override is set, OpenClaw calls `https://ollama.com/api/web_search`.

OpenClaw reads the API key from `models.providers.ollama.apiKey` or the
`OLLAMA_API_KEY` environment variable. `ollama signin` writes this key for
you on the local host.

The Ollama API key is a cloud credential, so OpenClaw only attaches the
`Authorization: Bearer <apiKey>` header when the web-search base URL is the
canonical `https://ollama.com` host. Custom `webSearch.baseUrl` overrides
(self-hosted proxies) never receive the Ollama API key; add any auth your
proxy needs at the proxy layer.

Because cloud routing is the default, OpenClaw also shows a one-line notice
at setup time confirming that queries will be sent to
`https://ollama.com/api/web_search`.

## Notes

- No web-search-specific API key field is required; the provider reuses the
  normal Ollama credential only when calling Ollama Cloud.
- OpenClaw warns during setup if `ollama signin` has not been completed, but
  it does not block selection.
- Runtime auto-detect can fall back to Ollama Web Search when no higher-priority
  credentialed provider is configured.
- The provider uses Ollama Cloud's `/api/web_search` endpoint.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Ollama](/providers/ollama) -- Ollama model setup and cloud/local modes
