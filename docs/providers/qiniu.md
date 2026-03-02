---
summary: "Use Qiniu Cloud's unified AI API to access 50+ models in OpenClaw"
read_when:
  - You want to use Qiniu Cloud AI inference service in OpenClaw
  - You want a single API key for many LLMs via Qiniu Cloud
title: "Qiniu Cloud (七牛云)"
---

# Qiniu Cloud (七牛云)

Qiniu Cloud provides a **unified AI inference API** that gives access to 50+ models — including
DeepSeek, Qwen, Claude, GPT, Gemini, and more — behind a single endpoint and API key.
The API is OpenAI-compatible (`/v1/chat/completions`) and also supports the Anthropic messages format.

## Get an API Key

1. Sign in at [qiniu.com](https://www.qiniu.com) (Mainland China account required).
2. Navigate to **AI 大模型推理** → **API Key Management** to generate your key.
3. New users receive a free token quota to get started.

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider qiniu --token "$QINIU_API_KEY"
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

## Notes

- Base URL is `https://api.qnaigc.com` (no trailing `/v1` needed — OpenClaw appends the path automatically).
- Model IDs must match exactly the **API model parameter** shown in Qiniu's [model list](https://developer.qiniu.com/aitokenapi/12883/model-list).
- Only `deepseek-r1` returns thinking traces by default (wrapped in `<think>` tags).
- The API also supports the Anthropic messages format; set `api: "anthropic-messages"` to use it.
- Service is currently only available to Mainland China accounts.
- For the full list of supported models, visit [qiniu.com/ai/models](https://www.qiniu.com/ai/models).
