---
summary: "使用 OpenRouter 的統一 API，在 OpenClaw 中存取多種模型"
read_when:
  - 你希望以單一 API 金鑰使用多個 LLM
  - 你希望在 OpenClaw 中透過 OpenRouter 執行模型
title: "OpenRouter"
---

# OpenRouter

OpenRouter 提供 **統一 API**，可透過單一端點與 API 金鑰，將請求路由至多個模型。它與 OpenAI 相容，因此只要切換基礎 URL，大多數 OpenAI SDK 都能正常運作。 It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

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

- 模型參照為 `openrouter/<provider>/<model>`。
- 如需更多模型／提供者選項，請參閱 [/concepts/model-providers](/concepts/model-providers)。
- OpenRouter 在底層使用夾帶你的 API 金鑰的 Bearer 權杖。
