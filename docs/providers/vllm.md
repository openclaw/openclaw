---
summary: "Run OpenClaw with vLLM (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM"
---

# vLLM

vLLM can serve open-source (and some custom) models via an **OpenAI-compatible** HTTP API. OpenClaw can connect to vLLM using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from vLLM when you opt in with `VLLM_API_KEY` (any value works if your server doesn’t enforce auth) and you do not define an explicit `models.providers.vllm` entry.

## Quick start

1. Start vLLM with an OpenAI-compatible server.

Your base URL should expose `/v1` endpoints (e.g. `/v1/models`, `/v1/chat/completions`). vLLM commonly runs on:

- `http://127.0.0.1:8000/v1`

2. Opt in (any value works if no auth is configured):

```bash
export VLLM_API_KEY="vllm-local"
```

3. Select a model (replace with one of your vLLM model IDs):

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and you **do not** define `models.providers.vllm`, OpenClaw will query:

- `GET http://127.0.0.1:8000/v1/models`

…and convert the returned IDs into model entries.

If you set `models.providers.vllm` explicitly, auto-discovery is skipped and you must define models manually.

## Explicit configuration (manual models)

Use explicit config when:

- vLLM runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
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
curl http://127.0.0.1:8000/v1/models
```

- If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.vllm`.
