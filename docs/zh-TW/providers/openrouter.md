---
summary: "使用 OpenRouter 的統一 API 在 OpenClaw 中存取多種模型"
read_when:
  - 您希望使用單一 API 金鑰存取多種 LLM
  - 您希望在 OpenClaw 中透過 OpenRouter 執行模型
title: "OpenRouter"
---

# OpenRouter

OpenRouter 提供**統一的 API**，可將請求路由至單一端點和 API 金鑰後方的多種模型。它與 OpenAI 相容，因此大多數 OpenAI SDK 只要切換基礎 URL 即可運作。

## CLI 設定

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 設定程式碼片段

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

- 模型引用格式為 `openrouter/<provider>/<model>`。
- 有關更多模型/供應商選項，請參閱 [/concepts/model-providers](/concepts/model-providers)。
- OpenRouter 在底層使用帶有您的 API 金鑰的 Bearer token。
