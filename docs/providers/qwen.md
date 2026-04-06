---
summary: "Use Qwen Cloud via OpenClaw's bundled qwen provider"
read_when:
  - You want to use Qwen with OpenClaw
  - You previously used Qwen OAuth
title: "Qwen"
---

# Qwen

<Warning>

**Qwen OAuth has been removed.** The free-tier OAuth integration
(`qwen-portal`) that used `portal.qwen.ai` endpoints is no longer available.
See [Issue #49557](https://github.com/openclaw/openclaw/issues/49557) for
background.

</Warning>

## Recommended: Qwen Cloud

OpenClaw now treats Qwen as a first-class bundled provider with canonical id
`qwen`. The bundled provider targets the Qwen Cloud / Alibaba DashScope and
Coding Plan endpoints and keeps legacy `modelstudio` ids working as a
compatibility alias.

- Provider: `qwen`
- Preferred env var: `QWEN_API_KEY`
- Also accepted for compatibility: `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY`
- API style: OpenAI-compatible

If you want `qwen3.6-plus`, prefer the **Standard (pay-as-you-go)** endpoint.
Coding Plan support can lag behind the public catalog.

```bash
# Global Coding Plan endpoint
openclaw onboard --auth-choice qwen-api-key

# China Coding Plan endpoint
openclaw onboard --auth-choice qwen-api-key-cn

# Global Standard (pay-as-you-go) endpoint
openclaw onboard --auth-choice qwen-standard-api-key

# China Standard (pay-as-you-go) endpoint
openclaw onboard --auth-choice qwen-standard-api-key-cn
```

Legacy `modelstudio-*` auth-choice ids and `modelstudio/...` model refs still
work as compatibility aliases, but new setup flows should prefer the canonical
`qwen-*` auth-choice ids and `qwen/...` model refs.

After onboarding, set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "qwen/qwen3.5-plus" },
    },
  },
}
```

## Plan types and endpoints

| Plan                       | Region | Auth choice                | Endpoint                                         |
| -------------------------- | ------ | -------------------------- | ------------------------------------------------ |
| Standard (pay-as-you-go)   | China  | `qwen-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1`      |
| Standard (pay-as-you-go)   | Global | `qwen-standard-api-key`    | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan (subscription) | China  | `qwen-api-key-cn`          | `coding.dashscope.aliyuncs.com/v1`               |
| Coding Plan (subscription) | Global | `qwen-api-key`             | `coding-intl.dashscope.aliyuncs.com/v1`          |

The provider auto-selects the endpoint based on your auth choice. Canonical
choices use the `qwen-*` family; `modelstudio-*` remains compatibility-only.
You can override with a custom `baseUrl` in config.

Native Model Studio endpoints advertise streaming usage compatibility on the
shared `openai-completions` transport. OpenClaw keys that off endpoint
capabilities now, so DashScope-compatible custom provider ids targeting the
same native hosts inherit the same streaming-usage behavior instead of
requiring the built-in `qwen` provider id specifically.

## Get your API key

- **Manage keys**: [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys)
- **Docs**: [docs.qwencloud.com](https://docs.qwencloud.com/developer-guides/getting-started/introduction)

## Built-in catalog

OpenClaw currently ships this bundled Qwen catalog:

| Model ref                   | Input       | Context   | Notes                                              |
| --------------------------- | ----------- | --------- | -------------------------------------------------- |
| `qwen/qwen3.5-plus`         | text, image | 1,000,000 | Default model                                      |
| `qwen/qwen3.6-plus`         | text, image | 1,000,000 | Prefer Standard endpoints when you need this model |
| `qwen/qwen3-max-2026-01-23` | text        | 262,144   | Qwen Max line                                      |
| `qwen/qwen3-coder-next`     | text        | 262,144   | Coding                                             |
| `qwen/qwen3-coder-plus`     | text        | 1,000,000 | Coding                                             |
| `qwen/MiniMax-M2.5`         | text        | 1,000,000 | Reasoning enabled                                  |
| `qwen/glm-5`                | text        | 202,752   | GLM                                                |
| `qwen/glm-4.7`              | text        | 202,752   | GLM                                                |
| `qwen/kimi-k2.5`            | text, image | 262,144   | Moonshot AI via Alibaba                            |

Availability can still vary by endpoint and billing plan even when a model is
present in the bundled catalog.

Native-streaming usage compatibility applies to both the Coding Plan hosts and
the Standard DashScope-compatible hosts:

- `https://coding.dashscope.aliyuncs.com/v1`
- `https://coding-intl.dashscope.aliyuncs.com/v1`
- `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

## Qwen 3.6 Plus availability

`qwen3.6-plus` is available on the Standard (pay-as-you-go) Model Studio
endpoints:

- China: `dashscope.aliyuncs.com/compatible-mode/v1`
- Global: `dashscope-intl.aliyuncs.com/compatible-mode/v1`

If the Coding Plan endpoints return an "unsupported model" error for
`qwen3.6-plus`, switch to Standard (pay-as-you-go) instead of the Coding Plan
endpoint/key pair.

## Capability plan

The `qwen` extension is being positioned as the vendor home for the full Qwen
Cloud surface, not just coding/text models.

- Text/chat models: bundled now
- Tool calling, structured output, thinking: inherited from the OpenAI-compatible transport
- Image generation: planned at the provider-plugin layer
- Image/video understanding: bundled now on the Standard endpoint
- Speech/audio: planned at the provider-plugin layer
- Memory embeddings/reranking: planned through the embedding adapter surface
- Video generation: bundled now through the shared video-generation capability

## Multimodal add-ons

The `qwen` extension now also exposes:

- Video understanding via `qwen-vl-max-latest`
- Wan video generation via:
  - `wan2.6-t2v` (default)
  - `wan2.6-i2v`
  - `wan2.6-r2v`
  - `wan2.6-r2v-flash`
  - `wan2.7-r2v`

These multimodal surfaces use the **Standard** DashScope endpoints, not the
Coding Plan endpoints.

- Global/Intl Standard base URL: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- China Standard base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`

For video generation, OpenClaw maps the configured Qwen region to the matching
DashScope AIGC host before submitting the job:

- Global/Intl: `https://dashscope-intl.aliyuncs.com`
- China: `https://dashscope.aliyuncs.com`

That means a normal `models.providers.qwen.baseUrl` pointing at either the
Coding Plan or Standard Qwen hosts still keeps video generation on the correct
regional DashScope video endpoint.

For video generation, set a default model explicitly:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
    },
  },
}
```

Current bundled Qwen video-generation limits:

- Up to **1** output video per request
- Up to **1** input image
- Up to **4** input videos
- Up to **10 seconds** duration
- Supports `size`, `aspectRatio`, `resolution`, `audio`, and `watermark`
- Reference image/video mode currently requires **remote http(s) URLs**. Local
  file paths are rejected up front because the DashScope video endpoint does not
  accept uploaded local buffers for those references.

See [Video Generation](/tools/video-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `QWEN_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
