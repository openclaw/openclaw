---
summary: "在 OpenClaw 中使用 OpenRouter 的統一 API 存取許多模型"
read_when:
  - 您需要一個 API 金鑰來存取多個 LLM
  - 您想透過 OpenRouter 在 OpenClaw 中執行模型
title: "OpenRouter"
---

# OpenRouter

OpenRouter 提供一個**統一的 API**，可將請求路由至單一端點和 API 金鑰後方的許多模型。它與 OpenAI 相容，因此大多數 OpenAI SDK 都可以透過切換基礎 URL 來運作。

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

- 模型參考格式為 `openrouter/<provider>/<model>`。
- 如需更多模型/供應商選項，請參閱 [/concepts/model-providers](/concepts/model-providers)。
- OpenRouter 在底層使用帶有您 API 金鑰的 Bearer token。
