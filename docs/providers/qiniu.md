---
summary: "Use Qiniu unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many Chinese and international LLMs
  - You need Qiniu setup guidance
title: "Qiniu"
---

# Qiniu Provider Guide

Qiniu (七牛云) MaaS is a Chinese cloud provider that offers a **unified API** routing to many
LLMs behind a single endpoint (`https://api.qnaigc.com`) and API key. It uses an
**Anthropic-compatible** (`anthropic-messages`) protocol, so models respond with the same
structure as Anthropic's API.

## Prerequisites

1. A Qiniu Cloud account with MaaS access
2. A minimum balance of ¥100 on your account
3. An API key from the Qiniu console
4. OpenClaw installed on your system

## Getting Your API Key

1. Visit the [Qiniu console](https://portal.qiniu.com/ai-inference/api-key)
2. Create a new API key
3. Copy the key — it starts with `sk-`

## CLI Setup

```bash
openclaw onboard --auth-choice qiniu-api-key
```

Or set the environment variable:

```bash
export QINIU_API_KEY="sk-..."
```

## Config Snippet

```json5
{
  env: { QINIU_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "qiniu/minimax/minimax-m2.5" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      qiniu: {
        baseUrl: "https://api.qnaigc.com",
        apiKey: "${QINIU_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "minimax/minimax-m2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 128000,
          },
        ],
      },
    },
  },
}
```

## Surfaced Model Refs

The built-in Qiniu catalog surfaces the following model refs.
Model refs follow the pattern `qiniu/<model-id>`.

### MiniMax

| Ref                                      | Context | Reasoning | Vision |
| ---------------------------------------- | ------- | --------- | ------ |
| `qiniu/minimax/minimax-m2.5` _(default)_ | 200k    | ✓         | —      |
| `qiniu/minimax/minimax-m2.1`             | 200k    | ✓         | —      |
| `qiniu/minimax/minimax-m2`               | 200k    | ✓         | —      |
| `qiniu/MiniMax-M1`                       | 1M      | ✓         | —      |

### DeepSeek

| Ref                                              | Context | Reasoning | Vision |
| ------------------------------------------------ | ------- | --------- | ------ |
| `qiniu/deepseek/deepseek-v3.2-exp`               | 64k     | —         | —      |
| `qiniu/deepseek/deepseek-v3.2-exp-thinking`      | 64k     | ✓         | —      |
| `qiniu/deepseek/deepseek-v3.2-251201`            | 64k     | —         | —      |
| `qiniu/deepseek/deepseek-v3.1-terminus`          | 64k     | —         | —      |
| `qiniu/deepseek/deepseek-v3.1-terminus-thinking` | 64k     | ✓         | —      |
| `qiniu/deepseek-v3.1`                            | 64k     | —         | —      |
| `qiniu/deepseek-v3-0324`                         | 64k     | —         | —      |
| `qiniu/deepseek-v3`                              | 64k     | —         | —      |
| `qiniu/deepseek-r1-0528`                         | 64k     | ✓         | —      |
| `qiniu/deepseek-r1`                              | 64k     | ✓         | —      |

### Qwen

| Ref                                    | Context | Reasoning | Vision |
| -------------------------------------- | ------- | --------- | ------ |
| `qiniu/qwen3-235b-a22b-thinking-2507`  | 128k    | ✓         | —      |
| `qiniu/qwen3-235b-a22b-instruct-2507`  | 128k    | —         | —      |
| `qiniu/qwen3-235b-a22b`                | 128k    | ✓         | —      |
| `qiniu/qwen3-coder-480b-a35b-instruct` | 256k    | —         | —      |
| `qiniu/qwen3-max`                      | 128k    | ✓         | —      |
| `qiniu/qwen3-max-preview`              | 128k    | ✓         | —      |
| `qiniu/qwen3-32b`                      | 128k    | ✓         | —      |
| `qiniu/qwen3-30b-a3b`                  | 128k    | ✓         | —      |
| `qiniu/qwen3-30b-a3b-thinking-2507`    | 128k    | ✓         | —      |
| `qiniu/qwen3-30b-a3b-instruct-2507`    | 128k    | —         | —      |
| `qiniu/qwen3-next-80b-a3b-thinking`    | 128k    | ✓         | —      |
| `qiniu/qwen3-next-80b-a3b-instruct`    | 128k    | —         | —      |
| `qiniu/qwen-max-2025-01-25`            | 32k     | —         | —      |
| `qiniu/qwen-turbo`                     | 128k    | —         | —      |
| `qiniu/qwen3-vl-30b-a3b-thinking`      | 128k    | ✓         | ✓      |
| `qiniu/qwen-vl-max-2025-01-25`         | 32k     | —         | ✓      |
| `qiniu/qwen2.5-vl-72b-instruct`        | 128k    | —         | ✓      |
| `qiniu/qwen2.5-vl-7b-instruct`         | 128k    | —         | ✓      |

### GLM (Zhipu)

| Ref                  | Context | Reasoning | Vision |
| -------------------- | ------- | --------- | ------ |
| `qiniu/z-ai/glm-5`   | 128k    | ✓         | —      |
| `qiniu/z-ai/glm-4.7` | 128k    | —         | —      |
| `qiniu/z-ai/glm-4.6` | 128k    | —         | —      |
| `qiniu/glm-4.5`      | 128k    | —         | —      |
| `qiniu/glm-4.5-air`  | 128k    | —         | —      |

### Kimi (Moonshot)

| Ref                                 | Context | Reasoning | Vision |
| ----------------------------------- | ------- | --------- | ------ |
| `qiniu/moonshotai/kimi-k2.5`        | 256k    | ✓         | —      |
| `qiniu/moonshotai/kimi-k2-thinking` | 256k    | ✓         | —      |
| `qiniu/moonshotai/kimi-k2-0905`     | 256k    | —         | —      |
| `qiniu/kimi-k2`                     | 256k    | —         | —      |

### Doubao (ByteDance)

| Ref                              | Context | Reasoning | Vision |
| -------------------------------- | ------- | --------- | ------ |
| `qiniu/doubao-seed-1.6-thinking` | 128k    | ✓         | —      |
| `qiniu/doubao-seed-1.6`          | 128k    | —         | —      |
| `qiniu/doubao-seed-1.6-flash`    | 128k    | —         | —      |
| `qiniu/doubao-1.5-thinking-pro`  | 128k    | ✓         | —      |
| `qiniu/doubao-1.5-vision-pro`    | 128k    | —         | ✓      |
| `qiniu/doubao-1.5-pro-32k`       | 32k     | —         | —      |

### Others

| Ref                                | Provider | Context | Reasoning | Vision |
| ---------------------------------- | -------- | ------- | --------- | ------ |
| `qiniu/meituan/longcat-flash-lite` | Meituan  | 128k    | —         | —      |
| `qiniu/xiaomi/mimo-v2-flash`       | Xiaomi   | 128k    | —         | —      |

## Switch the Default Model

```bash
# Set default to DeepSeek R1
openclaw models set qiniu/deepseek-r1

# Set default to Qwen3 Max
openclaw models set qiniu/qwen3-max

# List all available models
openclaw models list
```

## Use as Fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["qiniu/minimax/minimax-m2.5"],
      },
    },
  },
}
```

## Notes

- Default model: `qiniu/minimax/minimax-m2.5`
- Base URL: `https://api.qnaigc.com`
- API protocol: `anthropic-messages` (Anthropic-compatible)
- Model refs follow the pattern `qiniu/<model-id>` — IDs with slashes are preserved as-is (e.g. `qiniu/deepseek/deepseek-r1`).
- Cost fields are all `0` — update them in your config if you need accurate spend tracking.
- For additional models available in the Qiniu model marketplace, copy the model ID from the [Qiniu model square](https://portal.qiniu.com/ai-inference/model-square) and add it to `models.providers.qiniu.models`.
- See [/concepts/model-providers](/concepts/model-providers) for general provider configuration rules.

## Troubleshooting

### "Unknown model: qiniu/..."

The Qiniu provider isn't injected yet. Fix by:

- Setting `QINIU_API_KEY` in your environment, or
- Adding `models.providers.qiniu.apiKey` to your config, then restarting the gateway:

```bash
openclaw gateway restart
openclaw models list
```

### Model not in the built-in catalog

Add it manually under `models.providers.qiniu.models` in `openclaw.json`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      qiniu: {
        baseUrl: "https://api.qnaigc.com",
        apiKey: "${QINIU_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "<model-id-from-marketplace>",
            name: "<display-name>",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Related Documentation

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qiniu OpenClaw Deployment Guide](https://developer.qiniu.com/las/13329/las-one-click-deployment-of-openclaw)
- [Qiniu API Key Console](https://portal.qiniu.com/ai-inference/api-key)
