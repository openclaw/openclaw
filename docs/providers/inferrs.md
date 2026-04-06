---
summary: "Run OpenClaw with inferrs (local LLM inference server)"
read_when:
  - You want to run OpenClaw against a local inferrs server
  - You want to run Gemma 4 or other models locally with OpenAI-compatible endpoints
title: "inferrs"
---

# inferrs

inferrs is a lightweight, self-contained LLM inference server that supports Gemma 4,
Qwen3, and other HuggingFace models via an **OpenAI-compatible** HTTP API.
OpenClaw connects to inferrs using the `openai-completions` API.

OpenClaw can **auto-discover** available models from inferrs when you opt in with
`INFERRS_API_KEY` (any value works if your server does not enforce auth) and you
do not define an explicit `models.providers.inferrs` entry.

## Quick start

1. Install inferrs and start serving a model:

```bash
brew tap ericcurtin/inferrs
brew install inferrs
inferrs serve google/gemma-4-E2B-it
```

By default inferrs listens on `http://127.0.0.1:8080`.

2. Opt in (any value works if no auth is configured):

```bash
export INFERRS_API_KEY="inferrs-local"
```

3. Select a model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "inferrs/google/gemma-4-E2B-it" },
    },
  },
}
```

## Model discovery (implicit provider)

When `INFERRS_API_KEY` is set (or an auth profile exists) and you **do not** define
`models.providers.inferrs`, OpenClaw will query:

- `GET http://127.0.0.1:8080/v1/models`

…and convert the returned IDs into model entries.

If you set `models.providers.inferrs` explicitly, auto-discovery is skipped and you
must define models manually.

## Explicit configuration (manual models)

Use explicit config when:

- inferrs runs on a different host or port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key.

```json5
{
  models: {
    providers: {
      inferrs: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "${INFERRS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "google/gemma-4-E2B-it",
            name: "Gemma 4 (local)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Troubleshooting

- Check the server is reachable:

```bash
curl http://127.0.0.1:8080/v1/models
```

- If requests fail with auth errors, set `INFERRS_API_KEY` to any value (inferrs
  does not enforce auth by default) or configure the provider explicitly under
  `models.providers.inferrs`.

## Proxy-style behavior

inferrs is treated as a proxy-style OpenAI-compatible `/v1` backend.

- Native OpenAI-only request shaping does not apply here.
- No `service_tier`, no Responses `store`, no prompt-cache hints, and no OpenAI
  reasoning-compat payload shaping.
- Hidden OpenClaw attribution headers are not injected on custom inferrs base URLs.
