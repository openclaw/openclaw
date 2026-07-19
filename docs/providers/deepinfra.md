---
summary: "Use DeepInfra's unified API to access the most popular open source and frontier models in OpenClaw"
read_when:
  - You want a single API key for the top open source LLMs
  - You want to run models via DeepInfra's API in OpenClaw
title: "DeepInfra"
---

DeepInfra routes requests to popular open source and frontier models behind a
single OpenAI-compatible endpoint and API key. Most OpenAI SDKs work against
it by switching the base URL.

## Install plugin

```bash
openclaw plugins install @openclaw/deepinfra-provider
openclaw gateway restart
```

## Get an API key

1. Sign in at [deepinfra.com](https://deepinfra.com/)
2. Go to Dashboard / Keys and generate a key, or use the auto-created one

## CLI setup

```bash
openclaw onboard --deepinfra-api-key <key>
```

Or set the environment variable:

```bash
export DEEPINFRA_API_KEY="<your-deepinfra-api-key>" # pragma: allowlist secret
```

## Config snippet

```json5
{
  env: { DEEPINFRA_API_KEY: "<your-deepinfra-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "deepinfra/deepseek-ai/DeepSeek-V4-Flash" },
    },
  },
}
```

## Supported surfaces

Chat, image generation, and video generation refresh their model catalogs
live from `https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta`
once `DEEPINFRA_API_KEY` is configured. Other surfaces use the static
defaults below until they move onto the same live catalog.

| Surface                  | Default model                                                                                         | OpenClaw config/tool                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Chat / model provider    | first chat-tagged entry from live catalog (static fallback `deepseek-ai/DeepSeek-V4-Flash`)           | `agents.defaults.model`                                  |
| Image generation/editing | first `image-gen`-tagged entry from live catalog (static fallback `black-forest-labs/FLUX-1-schnell`) | `image_generate`, `agents.defaults.imageGenerationModel` |
| Media understanding      | `moonshotai/Kimi-K2.5` for images                                                                     | inbound image understanding                              |
| Speech-to-text           | `openai/whisper-large-v3-turbo`                                                                       | inbound audio transcription                              |
| Text-to-speech           | `hexgrad/Kokoro-82M`                                                                                  | `messages.tts.provider: "deepinfra"`                     |
| Video generation         | static fallback `Pixverse/Pixverse-T2V` (no live video-gen rows from DeepInfra today)                 | `video_generate`, `agents.defaults.videoGenerationModel` |
| Memory embeddings        | `BAAI/bge-m3`                                                                                         | `memory.search.provider: "deepinfra"`                    |

DeepInfra also exposes reranking, classification, object-detection, and other
native model types. OpenClaw has no provider contract for those categories
yet, so this plugin does not register them.

## Available models

OpenClaw discovers DeepInfra models dynamically once a key is configured. Use
`/models deepinfra` or `openclaw models list --provider deepinfra` to see the
current list.

Any model on [deepinfra.com](https://deepinfra.com/) works with the
`deepinfra/` prefix:

```text
deepinfra/deepseek-ai/DeepSeek-V4-Flash
deepinfra/deepseek-ai/DeepSeek-V3.2
deepinfra/MiniMaxAI/MiniMax-M2.5
deepinfra/moonshotai/Kimi-K2.5
deepinfra/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B
deepinfra/zai-org/GLM-5.1
...and many more
```

## Notes

- Model refs are `deepinfra/<provider>/<model>` (for example `deepinfra/Qwen/Qwen3-Max`).
- Default chat model: `deepinfra/deepseek-ai/DeepSeek-V4-Flash`
- Base URL: `https://api.deepinfra.com/v1/openai`
- Native video generation uses `https://api.deepinfra.com/v1/inference/<model>`.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
