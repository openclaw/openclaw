---
read_when:
  - 你想用一个 API key 访问许多 LLM
  - 你想通过 OpenRouter 在 OpenClaw 中运行模型
summary: 使用 OpenRouter 的统一 API 在 OpenClaw 中访问许多模型
title: OpenRouter
x-i18n:
  generated_at: "2026-03-16T06:26:52Z"
  model: gpt-5.4
  provider: openai
  source_hash: b7e29fc9c456c64d567dd909a85166e6dea8388ebd22155a31e69c970e081586
  source_path: providers/openrouter.md
  workflow: 15
---

# OpenRouter

OpenRouter 提供一个**统一 API**，可通过单个
端点和 API key 将请求路由到许多模型。它与 OpenAI 兼容，因此大多数 OpenAI SDK 只需切换 base URL 即可使用。

## CLI 设置

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## 配置片段

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

## 说明

- 模型引用格式为 `openrouter/<provider>/<model>`。
- 关于更多模型/提供商选项，请参阅 [/concepts/model-providers](/concepts/model-providers)。
- OpenRouter 在底层使用带有你的 API key 的 Bearer token。
