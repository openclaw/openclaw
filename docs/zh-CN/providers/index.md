---
read_when:
  - 你想选择一个模型提供商
  - 你需要快速了解支持的 LLM 后端
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商
x-i18n:
  generated_at: "2026-02-01T21:35:01Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eb4a97438adcf610499253afcf8b2af6624f4be098df389a6c3746f14c4a901b
  source_path: providers/index.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用多种 LLM 提供商。选择一个提供商，完成认证，然后将默认模型设置为 `provider/model`。

在找聊天渠道文档（WhatsApp/Telegram/Discord/Slack/Mattermost（插件）/等）？请参阅[渠道](/channels)。

## 推荐：Venice (Venice AI)

Venice 是我们推荐的 Venice AI 配置方案，适合注重隐私的推理场景，并可选择使用 Opus 处理复杂任务。

- 默认：`venice/llama-3.3-70b`
- 综合最佳：`venice/claude-opus-45`（Opus 仍然是最强的）

参阅 [Venice AI](/providers/venice)。

## 快速开始

1. 向提供商进行认证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
}
```

## 提供商文档

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI，注重隐私)](/providers/venice)
- [Ollama (本地模型)](/providers/ollama)

## 转录提供商

- [Deepgram (音频转录)](/providers/deepgram)

## 社区工具

- [Claude Max API 代理](/providers/claude-max-api-proxy) - 将 Claude Max/Pro 订阅用作 OpenAI 兼容的 API 端点

如需完整的提供商目录（xAI、Groq、Mistral 等）及高级配置，请参阅[模型提供商](/concepts/model-providers)。
