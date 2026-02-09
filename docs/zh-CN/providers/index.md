---
read_when:
  - 你想选择一个模型提供商
  - 你需要快速了解支持的 LLM 后端
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商
x-i18n:
  generated_at: "2026-02-03T07:53:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: eb4a97438adcf610499253afcf8b2af6624f4be098df389a6c3746f14c4a901b
  source_path: providers/index.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用许多 LLM 提供商。选择一个提供商，进行认证，然后将默认模型设置为 `provider/model`。

正在寻找聊天渠道文档（WhatsApp/Telegram/Discord/Slack/Mattermost（插件）等）？参见[渠道](/channels)。

## 亮点：Venice（Venice AI）

Venice 是我们推荐的 Venice AI 设置，用于隐私优先的推理，并可选择使用 Opus 处理困难任务。

- 默认：`venice/llama-3.3-70b`
- 最佳综合：`venice/claude-opus-45`（Opus 仍然是最强的）

参见 [Venice AI](/providers/venice)。

## 快速开始

1. 与提供商进行认证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
}
```

## 提供商文档

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [Qwen（OAuth）](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI，注重隐私）](/providers/venice)
- [Ollama（本地模型）](/providers/ollama)

## 转录提供商

- [Deepgram（音频转录）](/providers/deepgram)

## 社区工具

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - 将 Claude Max/Pro 订阅作为 OpenAI 兼容的 API 端点使用

有关完整的提供商目录（xAI、Groq、Mistral 等）和高级配置，
参见[模型提供商](/concepts/model-providers)。
