---
title: "Model Studio"
summary: "Alibaba Cloud Model Studio setup (Coding Plan, dual region endpoints)"
read_when:
  - You want to use Alibaba Cloud Model Studio with OpenClaw
  - You need the API key env var for Model Studio
---

# Model Studio (Alibaba Cloud)

The Model Studio provider gives access to Alibaba Cloud Coding Plan models,
including Qwen and third-party models hosted on the platform.

- Provider: `modelstudio`
- Auth: `MODELSTUDIO_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice modelstudio-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "modelstudio/qwen3.5-plus" },
    },
  },
}
```

## Region endpoints

Model Studio has two endpoints based on region:

| Region     | Endpoint                             |
| ---------- | ------------------------------------ |
| China (CN) | `coding.dashscope.aliyuncs.com`      |
| Global     | `coding-intl.dashscope.aliyuncs.com` |

The provider auto-selects based on the auth choice (`modelstudio-api-key` for
global, `modelstudio-api-key-cn` for China). You can override with a custom
`baseUrl` in config.

## Available models

- **qwen3.5-plus** (default) - Qwen 3.5 Plus
- **qwen3-max** - Qwen 3 Max
- **qwen3-coder** series - Qwen coding models
- **GLM-5**, **GLM-4.7** - GLM models via Alibaba
- **Kimi K2.5** - Moonshot AI via Alibaba
- **MiniMax-M2.5** - MiniMax via Alibaba

Most models support image input. Context windows range from 200K to 1M tokens.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure
`MODELSTUDIO_API_KEY` is available to that process (for example, in
`~/.openclaw/.env` or via `env.shellEnv`).
