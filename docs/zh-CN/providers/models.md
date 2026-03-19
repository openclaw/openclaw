---
read_when:
  - 你想选择一个模型提供商
  - 你想要 LLM 身份验证 + 模型选择的快速设置示例
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商快速开始
x-i18n:
  generated_at: "2026-03-16T06:26:02Z"
  model: gpt-5.4
  provider: openai
  source_hash: 7a868ba56e93e6332f0e9dd3d3e2c79a08f369dbc96c400dfba141f347d40e8f
  source_path: providers/models.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用许多 LLM 提供商。选择一个，完成身份验证，然后将默认
模型设置为 `provider/model`。

## 快速开始（两步）

1. 使用该提供商进行身份验证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 支持的提供商（入门集合）

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [Mistral](/providers/mistral)
- [Synthetic](/providers/synthetic)
- [OpenCode（Zen + Go）](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI）](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

有关完整的提供商目录（xAI、Groq、Mistral 等）和高级配置，
请参见 [模型提供商](/concepts/model-providers)。
