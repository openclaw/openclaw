---
summary: "Use China's top AI models in OpenClaw via AIsa"
read_when:
  - You want to use Chinese AI models (Qwen, Kimi, GLM, DeepSeek, MiniMax) in OpenClaw
  - You need AISA_API_KEY setup
title: "AIsa"
---

# AIsa

[AIsa](https://marketplace.aisa.one/) provides a unified OpenAI-compatible gateway for China's top AI models at `https://api.aisa.one/v1`. One API key gives you access to Qwen, Kimi, GLM, DeepSeek, MiniMax, and more.

## Available models

| Model | Developer | Input $/1M | Output $/1M | Context | Vision | Reasoning |
|---|---|---|---|---|---|---|
| `minimax-m2.1` | MiniMax | $0.21 | $0.84 | 200k | — | — |
| `seed-1-8-251228` | ByteDance | $0.225 | $1.80 | 128k | — | — |
| `deepseek-v3.2` | DeepSeek | $0.28 | $0.42 | 128k | — | — |
| `kimi-k2.5` _(default)_ | Moonshot AI | $0.40 | $2.11 | 256k | — | ✓ |
| `qwen3-max` | Alibaba | $0.72 | $3.60 | 256k | ✓ | ✓ |
| `glm-5` | Zhipu AI | $1.00 | $3.20 | 200k | ✓ | ✓ |

## CLI setup

```bash
export AISA_API_KEY="sk-..."
openclaw onboard --auth-choice aisa-api-key
```

Or non-interactively:

```bash
openclaw onboard --aisa-api-key "sk-..."
```

Then set your default model:

```bash
openclaw models set aisa/kimi-k2.5
```

## Config snippet

```json5
{
  env: { AISA_API_KEY: "sk-..." },
  models: {
    "aisa/kimi-k2.5": { alias: "AIsa" }
  }
}
```

## Get an API key

Sign up at [marketplace.aisa.one](https://marketplace.aisa.one/) to get your API key.
