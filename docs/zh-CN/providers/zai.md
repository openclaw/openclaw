---
read_when:
  - 你想在 OpenClaw 中使用 Z.AI / GLM 模型
  - 你需要简单的 ZAI_API_KEY 配置
summary: 在 OpenClaw 中使用智谱 AI（GLM 模型）
title: Z.AI
x-i18n:
  generated_at: "2026-02-01T21:36:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2c24bbad86cf86c38675a58e22f9e1b494f78a18fdc3051c1be80d2d9a800711
  source_path: providers/zai.md
  workflow: 15
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它为 GLM 提供 REST API，并使用 API 密钥进行身份验证。请在 Z.AI 控制台中创建你的 API 密钥。OpenClaw 通过 `zai` 提供商配合 Z.AI API 密钥使用。

## CLI 设置

```bash
openclaw onboard --auth-choice zai-api-key
# 或非交互式
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## 配置片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## 注意事项

- GLM 模型以 `zai/<model>` 的形式提供（例如：`zai/glm-4.7`）。
- 参阅 [/providers/glm](/providers/glm) 了解模型系列概览。
- Z.AI 使用 Bearer 认证方式配合你的 API 密钥。
