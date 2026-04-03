---
title: "Qwen / Model Studio"
summary: "Alibaba Cloud Model Studio setup (Standard pay-as-you-go and Coding Plan, dual region endpoints)"
read_when:
  - You want to use Qwen (Alibaba Cloud Model Studio) with OpenClaw
  - You need the API key env var for Model Studio
  - You want to use the Standard (pay-as-you-go) or Coding Plan endpoint
---

# Qwen / Model Studio (Alibaba Cloud)

The Model Studio provider gives access to Alibaba Cloud models including Qwen
and third-party models hosted on the platform. Two billing plans are supported:
**Standard** (pay-as-you-go) and **Coding Plan** (subscription).

<Info>

If you need **`qwen3.6-plus`**, prefer **Standard (pay-as-you-go)**. Coding
Plan availability can lag behind the public Model Studio catalog, and the
Coding Plan API can reject a model until it appears in your plan's supported
model list.

</Info>

- Provider: `modelstudio`
- Auth: `MODELSTUDIO_API_KEY`
- API: OpenAI-compatible

## Quick start

### Standard (pay-as-you-go)

```bash
# China endpoint
openclaw onboard --auth-choice modelstudio-standard-api-key-cn

# Global/Intl endpoint
openclaw onboard --auth-choice modelstudio-standard-api-key
```

### Coding Plan (subscription)

```bash
# China endpoint
openclaw onboard --auth-choice modelstudio-api-key-cn

# Global/Intl endpoint
openclaw onboard --auth-choice modelstudio-api-key
```

After onboarding, set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "modelstudio/qwen3.5-plus" },
    },
  },
}
```

## Plan types and endpoints

| Plan                       | Region | Auth choice                       | Endpoint                                         |
| -------------------------- | ------ | --------------------------------- | ------------------------------------------------ |
| Standard (pay-as-you-go)   | China  | `modelstudio-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1`      |
| Standard (pay-as-you-go)   | Global | `modelstudio-standard-api-key`    | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan (subscription) | China  | `modelstudio-api-key-cn`          | `coding.dashscope.aliyuncs.com/v1`               |
| Coding Plan (subscription) | Global | `modelstudio-api-key`             | `coding-intl.dashscope.aliyuncs.com/v1`          |

The provider auto-selects the endpoint based on your auth choice. You can
override with a custom `baseUrl` in config.

## Get your API key

- **China**: [bailian.console.aliyun.com](https://bailian.console.aliyun.com/)
- **Global/Intl**: [modelstudio.console.alibabacloud.com](https://modelstudio.console.alibabacloud.com/)

## Available models

- **qwen3.5-plus** (default) — Qwen 3.5 Plus
- **qwen3.6-plus** — Qwen 3.6 Plus
- **qwen3-coder-plus**, **qwen3-coder-next** — Qwen coding models
- **GLM-5** — GLM models via Alibaba
- **Kimi K2.5** — Moonshot AI via Alibaba
- **MiniMax-M2.5** — MiniMax via Alibaba

Some models (qwen3.5-plus, qwen3.6-plus, kimi-k2.5) support image input. Context windows range from 200K to 1M tokens. Availability can vary by endpoint and billing plan.

## Qwen 3.6 Plus availability

`qwen3.6-plus` is available on the Standard (pay-as-you-go) Model Studio
endpoints:

- China: `dashscope.aliyuncs.com/compatible-mode/v1`
- Global: `dashscope-intl.aliyuncs.com/compatible-mode/v1`

If the Coding Plan endpoints return an "unsupported model" error for
`qwen3.6-plus`, switch to Standard (pay-as-you-go) instead of the Coding Plan
endpoint/key pair.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure
`MODELSTUDIO_API_KEY` is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).
