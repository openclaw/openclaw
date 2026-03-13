---
summary: Use Z.AI (GLM models) with OpenClaw
read_when:
  - You want Z.AI / GLM models in OpenClaw
  - You need a simple ZAI_API_KEY setup
title: Z.AI
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它提供 GLM 的 REST API，並使用 API 金鑰進行身份驗證。請在 Z.AI 控制台中建立您的 API 金鑰。OpenClaw 使用帶有 Z.AI API 金鑰的 `zai` 提供者。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLM 模型可作為 `zai/<model>` 使用（範例：`zai/glm-5`）。
- `tool_stream` 預設為啟用，用於 Z.AI 工具呼叫串流。設定 `agents.defaults.models["zai/<model>"].params.tool_stream` 為 `false` 可將其停用。
- 請參考 [/providers/glm](/providers/glm) 了解模型家族概覽。
- Z.AI 使用 Bearer 認證搭配您的 API 金鑰。
