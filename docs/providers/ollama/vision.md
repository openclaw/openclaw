---
summary: "Route image understanding through local or hosted Ollama vision models"
read_when:
  - You want image description through an Ollama vision model
  - You are configuring an image-model default for Ollama
title: "Ollama vision and image description"
sidebarTitle: "Vision"
---

## Vision and image description

The bundled Ollama plugin registers Ollama as an image-capable
media-understanding provider, so OpenClaw can route explicit image-description
requests and configured image-model defaults through local or hosted Ollama
vision models.

```bash
ollama pull qwen2.5vl:7b
export OLLAMA_API_KEY="ollama-local"
openclaw infer image describe --file ./photo.jpg --model ollama/qwen2.5vl:7b --json
```

`--model` must be a full `<provider/model>` ref; when set, `infer image
describe` tries that model first instead of skipping description for models
that already support native vision. If the call fails, OpenClaw can continue
through `agents.defaults.imageModel.fallbacks`; file/URL preparation errors
fail before fallback is attempted. Use `infer image describe` for OpenClaw's
image-understanding flow and configured `imageModel`; use `infer model run
--file` for a raw multimodal probe with a custom prompt.

To make Ollama the default image-understanding provider for inbound media:

```json5
{
  agents: {
    defaults: {
      imageModel: {
        primary: "ollama/qwen2.5vl:7b",
      },
    },
  },
}
```

Prefer the full `ollama/<model>` ref. A bare `imageModel` ref such as
`qwen2.5vl:7b` normalizes to `ollama/qwen2.5vl:7b` only when that exact model
is listed under `models.providers.ollama.models` with
`input: ["text", "image"]` and no other configured image provider exposes the
same bare id; otherwise use the provider prefix explicitly.

Slow local vision models can need a longer image-understanding timeout than
cloud models, and can crash on constrained hardware if Ollama tries to
allocate the model's full advertised vision context. Set a capability
timeout and cap `num_ctx`:

```json5
{
  models: {
    providers: {
      ollama: {
        models: [
          {
            id: "qwen2.5vl:7b",
            name: "qwen2.5vl:7b",
            input: ["text", "image"],
            params: { num_ctx: 2048, keep_alive: "1m" },
          },
        ],
      },
    },
  },
  tools: {
    media: {
      models: [
        {
          provider: "ollama",
          model: "qwen2.5vl:7b",
          timeoutSeconds: 300,
          capabilities: ["image"],
        },
      ],
      image: {
        timeoutSeconds: 180,
      },
    },
  },
}
```

This timeout applies to inbound image understanding and to the explicit
`view_image` tool. `models.providers.ollama.timeoutSeconds` still controls the
underlying Ollama HTTP request guard for normal model calls.

Live verification:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA_IMAGE=1 \
  pnpm test:live -- src/agents/tools/image-tool.ollama.live.test.ts
```

If you define `models.providers.ollama.models` manually, mark vision models
explicitly:

```json5
{
  id: "qwen2.5vl:7b",
  name: "qwen2.5vl:7b",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
}
```

OpenClaw rejects image-description requests for models not marked
image-capable. With implicit discovery, this comes from `/api/show`'s vision
capability.
