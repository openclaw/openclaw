---
summary: "在 OpenClaw 中使用 Z.AI (GLM 模型)"
read_when:
  - 您想在 OpenClaw 中使用 Z.AI / GLM 模型
  - 您需要簡單的 ZAI_API_KEY 設定
    title: "Z.AI"
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它為 GLM 提供 REST API，並使用 API 金鑰進行驗證。請在 Z.AI 控制台中建立您的 API 金鑰。OpenClaw 使用帶有 Z.AI API 金鑰的 `zai` 供應商。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
# 或非互動式
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定程式碼片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLM 模型可透過 `zai/<model>` 使用（例如：`zai/glm-5`）。
- 請參閱 [/providers/glm](/providers/glm) 以了解模型系列的總覽。
- Z.AI 使用 Bearer 認證搭配您的 API 金鑰。
