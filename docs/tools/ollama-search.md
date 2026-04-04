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
It uses Ollama's experimental web-search API and returns structured results
with titles, URLs, and snippets.

Unlike the Ollama model provider, this setup does not need an API key. It
does require:

- an Ollama host that is reachable from OpenClaw
- `ollama signin`

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
configured host.

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

Optional Ollama host override:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

If no explicit Ollama base URL is set, OpenClaw uses `http://127.0.0.1:11434`.

## Notes

- No API key field is required for this provider.
- OpenClaw warns during setup if Ollama is unreachable or not signed in, but
  it does not block selection.
- Runtime auto-detect can fall back to Ollama Web Search when no higher-priority
  credentialed provider is configured.
- The provider uses Ollama's experimental `/api/experimental/web_search`
  endpoint.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Ollama](/providers/ollama) -- Ollama model setup and cloud/local modes
