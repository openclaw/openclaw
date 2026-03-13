---
summary: Use OpenRouter's unified API to access many models in OpenClaw
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
title: OpenRouter
---

# OpenRouter

OpenRouter 提供一個 **統一 API**，能將請求路由到多個模型，並透過單一端點和 API 金鑰進行存取。它與 OpenAI 相容，因此大多數 OpenAI SDK 只需切換基底 URL 即可使用。

## CLI 設定

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 設定片段

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## 注意事項

- 模型參考為 `openrouter/<provider>/<model>`。
- 欲了解更多模型/提供者選項，請參考 [/concepts/model-providers](/concepts/model-providers)。
- OpenRouter 在底層使用帶有您的 API 金鑰的 Bearer token。
