---
read_when:
  - 你想选择一个模型提供商
  - 你需要 LLM 认证和模型选择的快速设置示例
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商快速入门
x-i18n:
  generated_at: "2026-02-01T21:35:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2f5b99207dc7860e0a7b541b61e984791f5d7ab1953b3e917365a248a09b025b
  source_path: providers/models.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用多种 LLM 提供商。选择一个，完成认证，然后将默认模型设置为 `provider/model` 格式。

## 推荐：Venice（Venice AI）

Venice 是我们推荐的 Venice AI 配置方案，注重隐私优先的推理，并提供使用 Opus 处理最困难任务的选项。

- 默认：`venice/llama-3.3-70b`
- 综合最佳：`venice/claude-opus-45`（Opus 仍然是最强的）

参见 [Venice AI](/providers/venice)。

## 快速开始（两个步骤）

1. 向提供商进行认证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
}
```

## 支持的提供商（入门集合）

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

如需查看完整的提供商目录（xAI、Groq、Mistral 等）及高级配置，请参阅[模型提供商](/concepts/model-providers)。
