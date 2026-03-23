---
read_when:
  - 你想用一个 API 密钥访问多种 LLM
  - 你想在 OpenClaw 中通过 OpenRouter 运行模型
summary: 使用 OpenRouter 的统一 API 在 OpenClaw 中访问多种模型
title: OpenRouter
x-i18n:
  generated_at: "2026-02-01T21:35:19Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b7e29fc9c456c64d567dd909a85166e6dea8388ebd22155a31e69c970e081586
  source_path: providers/openrouter.md
  workflow: 15
---

# OpenRouter

OpenRouter 提供了一个**统一 API**，通过单一端点和 API 密钥将请求路由到多种模型。它兼容 OpenAI，因此大多数 OpenAI SDK 只需切换 base URL 即可使用。

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

## 注意事项

- 模型引用格式为 `openrouter/<provider>/<model>`。
- 更多模型/提供商选项，请参阅[模型提供商](/concepts/model-providers)。
- OpenRouter 底层使用 Bearer 令牌和你的 API 密钥进行认证。
