---
summary: GLM model family overview + how to use it in OpenClaw
read_when:
  - You want GLM models in OpenClaw
  - You need the model naming convention and setup
title: GLM Models
---

# GLM 模型

GLM 是一個透過 Z.AI 平台提供的**模型家族**（非公司）。在 OpenClaw 中，GLM 模型可透過 `zai` 提供者及像 `zai/glm-5` 這樣的模型 ID 存取。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
```

## 設定片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLM 版本與可用性可能會變動，請參考 Z.AI 文件以取得最新資訊。
- 範例模型 ID 包含 `glm-5`、`glm-4.7` 及 `glm-4.6`。
- 有關提供者詳細資訊，請參閱 [/providers/zai](/providers/zai)。
