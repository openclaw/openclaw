---
summary: "Use Qiniu Cloud's unified AI API to access 100+ models in OpenClaw"
read_when:
  - You want to use Qiniu Cloud AI inference service in OpenClaw
  - You want a single API key for many LLMs via Qiniu Cloud
title: "Qiniu Cloud (七牛云)"
---

# Qiniu Cloud (七牛云)

Qiniu Cloud provides a **unified AI inference API** that gives access to 100+ models —
including DeepSeek, Qwen, Claude, GPT, Gemini, Grok, and more — behind a single endpoint
and API key. The API is OpenAI-compatible (`/v1/chat/completions`) and also supports the
Anthropic messages format.

Model catalog: [sufy.com/zh-CN/services/ai-inference/models](https://sufy.com/zh-CN/services/ai-inference/models)

## Get an API Key

1. Sign in at [qiniu.com](https://www.qiniu.com) (Mainland China account required).
2. Navigate to **AI 大模型推理** → **API Key Management** to generate your key.
3. New users receive a free token quota to get started.

## CLI setup

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://api.qnaigc.com" \
  --custom-model-id "deepseek-r1" \
  --custom-api-key "$QINIU_API_KEY" \
  --custom-compatibility openai \
  --custom-provider-id qiniu
```

## Config snippet

```json5
{
  models: {
    providers: {
      qiniu: {
        baseUrl: "https://api.qnaigc.com",
        apiKey: "sk-...",
        api: "openai-completions",
        models: [
          { id: "deepseek-r1", name: "DeepSeek R1" },
          { id: "deepseek-v3", name: "DeepSeek V3" },
          { id: "qwen-plus", name: "Qwen Plus" },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "qiniu/deepseek-r1" },
    },
  },
}
```

## Available models

Qiniu Cloud supports 100+ models across multiple categories. A selection of popular ones:

### Text / Chat

| Model                | Context | Provider      |
| -------------------- | ------- | ------------- |
| `deepseek-r1`        | 128K    | DeepSeek      |
| `deepseek-v3`        | 128K    | DeepSeek      |
| `claude-sonnet-4-6`  | 1M      | Anthropic     |
| `claude-opus-4-6`    | 200K    | Anthropic     |
| `gpt-5`              | 400K    | OpenAI        |
| `gemini-2.5-pro`     | 11M+    | Google        |
| `gemini-2.5-flash`   | 11M+    | Google        |
| `grok-4-fast`        | 2M      | xAI           |
| `qwen3-235b-a22b`    | 128K    | Alibaba Cloud |
| `kimi-k2`            | 128K    | Moonshot      |
| `doubao-1.5-pro-32k` | 128K    | ByteDance     |
| `glm-4.5`            | 131K    | ZhipuAI       |

### Image understanding

| Model                     | Provider      |
| ------------------------- | ------------- |
| `qwen-vl-max`             | Alibaba Cloud |
| `qwen2.5-vl-72b-instruct` | Alibaba Cloud |
| `doubao-1.5-vision-pro`   | ByteDance     |

### Image generation

| Model                    | Provider |
| ------------------------ | -------- |
| `kling-v2`               | Kling AI |
| `kling-v1-5`             | Kling AI |
| `gemini-2.5-flash-image` | Google   |

### Video generation

| Model                  | Provider |
| ---------------------- | -------- |
| `kling-v2-1`           | Kling AI |
| `sora-2`               | OpenAI   |
| `veo-3.0-generate-001` | Google   |

### Audio

| Model | Description                  |
| ----- | ---------------------------- |
| `asr` | Automatic speech recognition |
| `tts` | Text to speech               |

For the complete and up-to-date model list, visit [sufy.com/zh-CN/services/ai-inference/models](https://sufy.com/zh-CN/services/ai-inference/models).

## Notes

- Base URL is `https://api.qnaigc.com`.
- Model IDs must match the **API model parameter** shown in Qiniu's [model list](https://developer.qiniu.com/aitokenapi/12883/model-list).
- Only `deepseek-r1` returns thinking traces by default (wrapped in `<think>` tags).
- The API also supports Anthropic messages format; set `api: "anthropic-messages"` to use it.
- Service is currently only available to Mainland China accounts.
- For pricing, see [AI Token API Pricing](https://developer.qiniu.com/aitokenapi/12898/ai-token-api-pricing).
