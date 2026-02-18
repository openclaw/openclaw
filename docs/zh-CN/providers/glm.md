---
read_when:
  - 你想在 OpenClaw 中使用 GLM 模型
  - 你需要了解模型命名规范和设置方法
summary: GLM 模型系列概述 + 如何在 OpenClaw 中使用
title: GLM 模型
x-i18n:
  generated_at: "2026-02-01T21:34:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2d7b457f033f26f28c230a9cd2310151f825fc52c3ee4fb814d08fd2d022d041
  source_path: providers/glm.md
  workflow: 15
---

# GLM 模型

GLM 是一个**模型系列**（而非公司），通过 Z.AI 平台提供。在 OpenClaw 中，GLM 模型通过 `zai` 提供商访问，模型 ID 格式如 `zai/glm-4.7`。

## CLI 设置

```bash
openclaw onboard --auth-choice zai-api-key
```

## 配置片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 注意事项

- GLM 版本和可用性可能会变化；请查阅 Z.AI 的文档获取最新信息。
- 示例模型 ID 包括 `glm-4.7` 和 `glm-4.6`。
- 有关提供商的详细信息，请参阅 [/providers/zai](/providers/zai)。
