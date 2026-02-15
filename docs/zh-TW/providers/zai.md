---
summary: "將 Z.AI (GLM 模型) 與 OpenClaw 搭配使用"
read_when:
  - 您想要在 OpenClaw 中使用 Z.AI / GLM 模型
  - 您需要簡單的 ZAI_API_KEY 設定
title: "Z.AI"
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它為 GLM 提供 REST API，並使用 API 鍵進行憑證。請在 Z.AI console 中建立您的 API 鍵。OpenClaw 使用 `zai` 供應商和 Z.AI API 鍵。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
# 或非互動式
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 設定片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 說明

- GLM 模型可作為 `zai/<model>` (範例: `zai/glm-5`) 使用。
- 有關模型系列概述，請參閱 [/providers/glm](/providers/glm)。
- Z.AI 使用帶有您 API 鍵的 Bearer 憑證。
