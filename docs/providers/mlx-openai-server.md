---
summary: "Run OpenClaw with MLX OpenAI Server on Apple Silicon"
read_when:
  - You want to run OpenClaw against a local MLX OpenAI Server
  - You want OpenAI-compatible /v1 endpoints backed by Apple Silicon MLX models
title: "MLX OpenAI Server"
---

MLX OpenAI Server serves local MLX models on Apple Silicon through an **OpenAI-compatible** HTTP API. OpenClaw connects to MLX OpenAI Server using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from MLX OpenAI Server when you opt in with `MLX_OPENAI_SERVER_API_KEY` (any value works if your server does not enforce auth) and you do not define an explicit `models.providers["mlx-openai-server"]` entry.

OpenClaw treats `mlx-openai-server` as a local OpenAI-compatible provider that supports streamed usage accounting, so status/context token counts can update from `stream_options.include_usage` responses.

| Property         | Value                                            |
| ---------------- | ------------------------------------------------ |
| Provider ID      | `mlx-openai-server`                              |
| API              | `openai-completions` (OpenAI-compatible)         |
| Auth             | `MLX_OPENAI_SERVER_API_KEY` environment variable |
| Default base URL | `http://127.0.0.1:8000/v1`                       |

## Getting started

<Steps>
  <Step title="Start MLX OpenAI Server">
    Your base URL should expose `/v1` endpoints such as `/v1/models` and `/v1/chat/completions`.

    ```bash
    mlx-openai-server launch \
      --model-type lm \
      --model-path mlx-community/Qwen3-Coder-Next-4bit \
      --reasoning-parser qwen3_moe \
      --tool-call-parser qwen3_coder
    ```

  </Step>
  <Step title="Set the API key environment variable">
    Any value works if your server does not enforce auth:

    ```bash
    export MLX_OPENAI_SERVER_API_KEY="mlx-local"
    ```

  </Step>
  <Step title="Select a model">
    Replace with one of your served MLX model IDs:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "mlx-openai-server/mlx-community/Qwen3-Coder-Next-4bit" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider mlx-openai-server
    ```
  </Step>
</Steps>

## Model discovery (implicit provider)

When `MLX_OPENAI_SERVER_API_KEY` is set (or an auth profile exists) and you **do not** define `models.providers["mlx-openai-server"]`, OpenClaw queries:

```
GET http://127.0.0.1:8000/v1/models
```

and converts the returned IDs into model entries.

<Note>
If you set `models.providers["mlx-openai-server"]` explicitly, auto-discovery is skipped and you must define models manually.
</Note>

## Explicit configuration (manual models)

Use explicit config when:

- MLX OpenAI Server runs on a different host or port
- You want to pin `contextWindow` or `maxTokens` values
- Your server requires a real API key (or you want to control headers)
- You connect to a trusted loopback, LAN, or Tailscale endpoint

```json5
{
  models: {
    providers: {
      "mlx-openai-server": {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${MLX_OPENAI_SERVER_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        timeoutSeconds: 300, // Optional: extend connect/header/body/request timeout for slow local models
        models: [
          {
            id: "mlx-community/Qwen3-Coder-Next-4bit",
            name: "Local MLX Model",
            reasoning: true,
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

<AccordionGroup>
  <Accordion title="Connection refused">
    Check that MLX OpenAI Server is running and accessible:

    ```bash
    curl http://127.0.0.1:8000/v1/models
    ```

    If the server runs on another host, configure `models.providers["mlx-openai-server"].baseUrl` and, for trusted private-network endpoints, set `models.providers["mlx-openai-server"].request.allowPrivateNetwork: true`.

  </Accordion>

  <Accordion title="Authentication errors">
    If your server does not enforce auth, any non-empty value for `MLX_OPENAI_SERVER_API_KEY` works as an opt-in signal for OpenClaw. If your server does enforce auth, set `MLX_OPENAI_SERVER_API_KEY` to the real key or configure the provider explicitly.
  </Accordion>

  <Accordion title="Models not discovered">
    Auto-discovery requires `MLX_OPENAI_SERVER_API_KEY` to be set **and** no explicit `models.providers["mlx-openai-server"]` config entry. If you have defined the provider manually, OpenClaw skips discovery and uses only your declared models.
  </Accordion>
</AccordionGroup>
