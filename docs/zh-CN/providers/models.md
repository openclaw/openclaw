---
read_when:
  - 你想选择一个模型提供商
  - 你想要 LLM 认证 + 模型选择的快速设置示例
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商快速入门
x-i18n:
  generated_at: "2026-02-03T07:53:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2f5b99207dc7860e0a7b541b61e984791f5d7ab1953b3e917365a248a09b025b
  source_path: providers/models.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用许多 LLM 提供商。选择一个，进行认证，然后将默认模型设置为 `provider/model`。

## 推荐：Venice（Venice AI）

Venice 是我们推荐的 Venice AI 设置，用于隐私优先的推理，并可选择使用 Opus 处理最困难的任务。

- 默认：`venice/llama-3.3-70b`
- 最佳综合：`venice/claude-opus-45`（Opus 仍然是最强的）

参见 [Venice AI](/providers/venice)。

## 快速开始（两个步骤）

1. 与提供商认证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
}
```

## 支持的提供商（入门集）

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI）](/providers/venice)
- [Amazon Bedrock](/bedrock)

有关完整的提供商目录（xAI、Groq、Mistral 等）和高级配置，请参阅[模型提供商](/concepts/model-providers)。
