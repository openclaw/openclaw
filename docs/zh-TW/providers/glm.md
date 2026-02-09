---
summary: "GLM 模型家族概覽＋如何在 OpenClaw 中使用"
read_when:
  - 你想在 OpenClaw 中使用 GLM 模型
  - 你需要模型命名慣例與設定方式
title: "GLM 模型"
---

# GLM 模型

GLM 是一個**模型家族**（不是公司），可透過 Z.AI 平台使用。在 OpenClaw 中，GLM
模型是透過 `zai` 提供者存取，並使用像是 `zai/glm-4.7` 的模型 ID。 14. 在 OpenClaw 中，GLM
模型是透過 `zai` 提供者存取，並使用如 `zai/glm-4.7` 的模型 ID。

## CLI 設定

```bash
openclaw onboard --auth-choice zai-api-key
```

## 設定片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 注意事項

- GLM 版本與可用性可能會變更；請查看 Z.AI 的文件以取得最新資訊。
- 範例模型 ID 包含 `glm-4.7` 與 `glm-4.6`。
- 提供者詳細資訊，請參見 [/providers/zai](/providers/zai)。
