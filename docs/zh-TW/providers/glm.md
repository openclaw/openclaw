---
summary: "GLM 模型家族概覽 + 如何在 OpenClaw 中使用它"
read_when:
  - 您希望在 OpenClaw 中使用 GLM 模型
  - 您需要模型命名慣例和設定
title: "GLM 模型"
---

# GLM 模型

GLM 是一個**模型家族** (而非一家公司)，可透過 Z.AI 平台取得。在 OpenClaw 中，GLM 模型是透過 `zai` 供應商和諸如 `zai/glm-5` 的模型 ID 存取。

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

## 備註

- GLM 版本和可用性可能會變更；請查閱 Z.AI 的文件以了解最新資訊。
- 範例模型 ID 包含 `glm-5`、`glm-4.7` 和 `glm-4.6`。
- 有關供應商詳情，請參閱 [/providers/zai](/providers/zai)。
