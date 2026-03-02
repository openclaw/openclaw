---
summary: "Use Qiniu Cloud AI's unified API to access 50+ models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Qiniu Cloud AI in OpenClaw
title: "Qiniu"
---

# Qiniu Cloud AI

Qiniu Cloud AI (七牛云 AI 大模型推理) is a high-performance MaaS platform that provides a **unified API** routing
requests to 50+ mainstream models behind a single endpoint and API key. It is OpenAI-compatible,
so most OpenAI SDKs work by switching the base URL.

## Prerequisites

1. A Qiniu Cloud account with AI inference access
2. An API key from the [Qiniu AI Console](https://qiniu.com/ai)
3. OpenClaw installed on your system

## Getting Your API Key

1. Visit [qiniu.com/ai](https://qiniu.com/ai) and sign up / log in
2. Go to **Console > AI Large Model Inference > API Key**
3. Create a new API key and copy it

## CLI setup

```bash
openclaw onboard --auth-choice apiKey --token-provider qiniu --token "$QINIU_API_KEY"
```

## Config snippet

```json5
{
  env: { QINIU_API_KEY: "your-api-key" },
  agents: {
    defaults: {
      model: { primary: "qiniu/deepseek/deepseek-v3.2-251201" },
    },
  },
}
```

## Notes

- Model refs are `qiniu/<model>` (e.g. `qiniu/deepseek/deepseek-v3.2-251201`).
- Available models can be listed via the `/v1/models` endpoint.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- Qiniu Cloud AI uses a Bearer token with your API key under the hood.
- [Qiniu AI Inference API Documentation](https://developer.qiniu.com/aitokenapi/12882/ai-inference-api)
