---
summary: "GLM 模型家族概覽及如何在 OpenClaw 中使用"
read_when:
  - 你想在 OpenClaw 中使用 GLM 模型
  - 你需要瞭解模型命名慣例與設定方法
title: "GLM 模型"
---

# GLM 模型

GLM 是一個經由 Z.AI 平台提供的**模型家族**（並非公司）。在 OpenClaw 中，GLM 模型是透過 `zai` 供應商以及如 `zai/glm-5` 的模型 ID 來存取的。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
```

## 設定程式碼片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## 注意事項

- GLM 版本與可用性可能會有所變動；請查看 Z.AI 的文件以獲取最新資訊。
- 範例模型 ID 包括 `glm-5`、`glm-4.7` 以及 `glm-4.6`。
- 關於供應商詳情，請參閱 [/providers/zai](/providers/zai)。
