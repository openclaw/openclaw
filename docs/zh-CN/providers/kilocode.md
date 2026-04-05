---
read_when:
  - 你想用一个 API 密钥访问多种 LLM
  - 你想在 OpenClaw 中通过 Kilo Gateway 运行模型
summary: 使用 Kilo Gateway 的统一 API 在 OpenClaw 中访问多种模型
x-i18n:
  generated_at: "2026-03-16T06:25:35Z"
  model: gpt-5.4
  provider: openai
  source_hash: acd4c29496abc1ef8d4da6c48575763dfe3b4c1319874f900532223ac3775257
  source_path: providers/kilocode.md
  workflow: 15
---

# Kilo Gateway

Kilo Gateway 提供一个**统一 API**，可通过单一
端点和 API 密钥将请求路由到多种模型。它兼容 OpenAI，因此大多数 OpenAI SDK 只需切换基础 URL 即可使用。

## 获取 API 密钥

1. 前往 [app.kilo.ai](https://app.kilo.ai)
2. 登录或创建账户
3. 进入 API Keys 并生成一个新密钥

## CLI 设置

```bash
openclaw onboard --kilocode-api-key <key>
```

或者设置环境变量：

```bash
export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
```

## 配置片段

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

## 默认模型

默认模型是 `kilocode/kilo/auto`，这是一个智能路由模型，会根据任务自动选择
最佳的底层模型：

- 规划、调试和编排任务会路由到 Claude Opus
- 代码编写和探索任务会路由到 Claude Sonnet

## 可用模型

OpenClaw 会在启动时从 Kilo Gateway 动态发现可用模型。使用
`/models kilocode` 查看你的账户可用的完整模型列表。

Gateway 网关上任何可用的模型都可以使用 `kilocode/` 前缀：

```
kilocode/kilo/auto              (default - smart routing)
kilocode/anthropic/claude-sonnet-4
kilocode/openai/gpt-5.4
kilocode/google/gemini-3-pro-preview
...and many more
```

## 说明

- 模型引用格式为 `kilocode/<model-id>`（例如 `kilocode/anthropic/claude-sonnet-4`）。
- 默认模型：`kilocode/kilo/auto`
- 基础 URL：`https://api.kilo.ai/api/gateway/`
- 更多模型/提供商选项，请参见 [/concepts/model-providers](/concepts/model-providers)。
- Kilo Gateway 在底层使用带有你的 API 密钥的 Bearer token。
