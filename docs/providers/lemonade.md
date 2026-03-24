---
summary: "Run OpenClaw with Lemonade Server (local AI with GPU/NPU acceleration, OpenAI-compatible)"
read_when:
  - You want to run OpenClaw against a local Lemonade Server instance
  - You want to use GPU or NPU-accelerated local models
  - You want OpenAI-compatible /api/v1 endpoints with Lemonade
title: "Lemonade"
---

# Lemonade

[Lemonade Server](https://lemonade-server.ai/) is a local AI server that provides an OpenAI-compatible HTTP API. It supports multiple backends (llama.cpp, ONNX Runtime GenAI, FastFlowLM, whisper.cpp, stable-diffusion.cpp) and can accelerate inference using CPU, GPU, and NPU hardware.

OpenClaw connects to Lemonade using the `openai-completions` API and **auto-discovers** available models when the server is running — no API key or extra configuration required.

1. Install and start Lemonade Server (see [Lemonade getting started](https://lemonade-server.ai/docs/getting_started/)). Once running,
   the server listens on `http://127.0.0.1:8000` by default, with OpenAI-compatible endpoints at `/api/v1/`.

2. Select a model (replace with one of your Lemonade model IDs from `GET /api/v1/models`):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lemonade/Qwen3-0.6B-GGUF" },
    },
  },
}
```

That's it. OpenClaw will automatically discover models from the running Lemonade Server.

## Model discovery (implicit provider)

When Lemonade Server is running and you **do not** define `models.providers.lemonade`, OpenClaw will automatically query:

- `GET http://127.0.0.1:8000/api/v1/models`

...and register the returned models. No `LEMONADE_API_KEY` is needed — the server does not enforce auth by default.

If you set `models.providers.lemonade` explicitly with models, auto-discovery is skipped and only your manually defined models are used.

## Explicit configuration (manual models)

Use explicit config when:

- Lemonade runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- You want to control which models are available.

```json5
{
  models: {
    providers: {
      lemonade: {
        baseUrl: "http://127.0.0.1:8000/api/v1",
        api: "openai-completions",
        models: [
          {
            id: "Qwen3-0.6B-GGUF",
            name: "Qwen3 0.6B (GGUF)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

If your server requires authentication, add `apiKey: "${LEMONADE_API_KEY}"` to the provider block and set the env var accordingly.

## Supported backends

Lemonade Server supports multiple model backends:

| Backend              | Format       | Hardware               |
| -------------------- | ------------ | ---------------------- |
| llama.cpp            | .GGUF        | CPU, GPU (Vulkan/ROCm) |
| ONNX Runtime GenAI   | .ONNX        | NPU (Ryzen AI)         |
| FastFlowLM           | .q4nx        | NPU (Ryzen AI)         |
| whisper.cpp          | .bin         | CPU, NPU               |
| stable-diffusion.cpp | .safetensors | CPU, GPU               |

## Troubleshooting

- Check the server is reachable:

```bash
curl http://127.0.0.1:8000/api/v1/health
```

- List available models:

```bash
curl http://127.0.0.1:8000/api/v1/models
```

- If models are not appearing, make sure they are downloaded via the Lemonade web app (`http://localhost:8000`) or the `/api/v1/pull` endpoint.

- If your server is configured with authentication, set `LEMONADE_API_KEY` or configure the provider explicitly under `models.providers.lemonade`.
