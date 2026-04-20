---
summary: "Ollama Web Search via your configured Ollama host or Ollama Cloud"
read_when:
  - You want to use Ollama for web_search
  - You need Ollama Web Search setup guidance
title: "Ollama Web Search"
---

# Ollama Web Search

OpenClaw supports **Ollama Web Search** as a bundled `web_search` provider.
It returns structured results with titles, URLs, and snippets.

OpenClaw uses this compatibility order:

1. your configured Ollama host via `/api/web_search`
2. the legacy local `/api/experimental/web_search` path
3. `https://ollama.com/api/web_search` when a real `OLLAMA_API_KEY` is available

That means:

- local or self-hosted Ollama can work without a separate hosted API key if the
  host exposes a supported web-search endpoint
- Ollama Cloud requires `OLLAMA_API_KEY`
- `ollama signin` still matters for host-backed cloud access checks and any
  local-host path that requires sign-in-backed search support

## Setup

<Steps>
  <Step title="Choose local or cloud">
    - **Local or self-hosted Ollama**: make sure the configured Ollama host is
      reachable from OpenClaw. If the host gates cloud-backed features, run
      `ollama signin`.
    - **Ollama Cloud**: export `OLLAMA_API_KEY` or configure
      `models.providers.ollama.apiKey`.
  </Step>

  <Step title="Choose Ollama Web Search">
    Run:

    ```bash
    openclaw configure --section web
    ```

    Then select **Ollama Web Search** as the provider.

  </Step>

  <Step title="Optional cloud key">
    For Ollama Cloud or hosted fallback, set:

    ```bash
    export OLLAMA_API_KEY="your-ollama-api-key"
    ```

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

If your Ollama host expects bearer auth, set
`models.providers.ollama.apiKey` and OpenClaw will attach it to requests sent
to the configured host. That provider-scoped key is never forwarded to
`https://ollama.com`.

To run against Ollama Cloud directly, set the Ollama provider base URL to
`https://ollama.com` and provide a real `OLLAMA_API_KEY`. To keep using a
local host and fall back to Ollama Cloud on `404`, export `OLLAMA_API_KEY`
without changing `baseUrl`.

<Warning>
**Upgrade note:** previously, `models.providers.ollama.baseUrl = "https://ollama.com"` was silently redirected to the local default for web search. As of the 2026.4.x release, that config is honored and Ollama Web Search will only attempt the cloud endpoint. If you relied on the implicit local fallback, either unset `baseUrl` to use `http://127.0.0.1:11434`, or set `OLLAMA_API_KEY` for cloud access.
</Warning>

## Notes

- No web-search-specific API key field is required for this provider.
- If the Ollama host is auth-protected, set `models.providers.ollama.apiKey`
  and that key is sent only to the configured host.
- If the configured Ollama host returns `404` for both supported local search
  paths and an env-sourced `OLLAMA_API_KEY` is available, OpenClaw retries
  against Ollama Cloud automatically. A `models.providers.ollama.apiKey` alone
  does not trigger the cloud fallback.
- OpenClaw warns during setup if Ollama is unreachable or not signed in, but
  it does not block selection.
- Runtime auto-detect can fall back to Ollama Web Search when no higher-priority
  credentialed provider is configured.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Ollama](/providers/ollama) -- Ollama model setup and cloud/local modes
