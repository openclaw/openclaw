---
summary: "Run OpenClaw with Atomic Chat (OpenAI-compatible local LLM server)"
read_when:
  - You want to run OpenClaw against a local Atomic Chat server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "Atomic Chat"
---

# Atomic Chat

Atomic Chat serves local models via an **OpenAI-compatible** HTTP API.
OpenClaw can connect to Atomic Chat using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from Atomic Chat when the
server is running and you do not define an explicit
`models.providers.atomic-chat` entry.

## Quick start

1. Start Atomic Chat and load a model.

Your base URL should expose `/v1` endpoints (for example `/v1/models`,
`/v1/chat/completions`). Atomic Chat commonly runs on:

- `http://127.0.0.1:1337/v1`

2. Run onboarding and choose `Atomic Chat`:

```bash
openclaw onboard
```

The setup wizard checks that Atomic Chat is reachable and has at least one
model loaded. If not, it asks you to start the server or load a model first.

3. Or set a model directly:

```json5
{
  agents: {
    defaults: {
      model: { primary: "atomic-chat/Qwen3_5-9B-Q4_K_M" },
    },
  },
}
```

## Model discovery (implicit provider)

When `ATOMIC_CHAT_API_KEY` is set (or an auth profile exists) and you **do
not** define `models.providers.atomic-chat`, OpenClaw will query:

- `GET http://127.0.0.1:1337/v1/models`

and convert the returned IDs into model entries.

If you set `models.providers.atomic-chat` explicitly, auto-discovery is
skipped and you must define models manually.

## Explicit configuration (manual models)

Use explicit config when:

- Atomic Chat runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.

```json5
{
  models: {
    providers: {
      "atomic-chat": {
        baseUrl: "http://127.0.0.1:1337/v1",
        apiKey: "${ATOMIC_CHAT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Qwen3_5-9B-Q4_K_M",
            name: "Qwen 3.5 9B",
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
curl http://127.0.0.1:1337/v1/models
```

- If no models are returned, load a model in Atomic Chat first.
