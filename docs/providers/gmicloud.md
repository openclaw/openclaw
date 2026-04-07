---
summary: "GMI Cloud setup (auth + model selection)"
read_when:
  - You want to use GMI Cloud with OpenClaw
  - You need the API key env var or CLI auth choice
---

# GMI Cloud

[GMI Cloud](https://www.gmicloud.ai/) provides GPU cloud inference with access to popular open-source models including DeepSeek, Qwen, Llama, and Kimi through an OpenAI-compatible API.

- Provider: `gmicloud`
- Auth: `GMI_CLOUD_API_KEY`
- API: OpenAI-compatible (`https://api.gmi-serving.com/v1`)

## Quick start

1. Set the API key:

```bash
openclaw onboard --auth-choice gmicloud-api-key
```

2. Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "gmicloud/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice gmicloud-api-key \
  --gmicloud-api-key "$GMI_CLOUD_API_KEY"
```

## Available models

The current curated catalog in the plugin includes:

- **Anthropic**: `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`
- **GPT**: `openai/gpt-5.4`, `openai/gpt-5.4-pro`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`
- **Google Gemini**: `google/gemini-3.1-pro-preview`, `google/gemini-3.1-flash-lite-preview`
- **GLM**: `zai-org/GLM-5-FP8`, `zai-org/GLM-4.6`
- **DeepSeek**: `deepseek-ai/DeepSeek-V3.1`, `deepseek-ai/DeepSeek-V3.2`
- **Kimi**: `moonshotai/Kimi-K2.5`, `moonshotai/Kimi-K2-Thinking`, `moonshotai/Kimi-K2-Instruct-0905`
- **Qwen**: `Qwen/Qwen3-32B-FP8`, `Qwen/Qwen3-Next-80B-A3B-Instruct`, `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`, `Qwen/Qwen3-235B-A22B-Thinking-2507-FP8`
- **Llama**: `meta-llama/Llama-4-Scout-17B-16E-Instruct`

The plugin also supports dynamic model resolution for valid GMI Cloud model IDs not yet listed in this curated catalog.
