---
read_when:
  - 你想选择一个模型提供商
  - 你需要支持的 LLM 后端的快速概览
summary: OpenClaw 支持的模型提供商（LLM）
title: 模型提供商
x-i18n:
  generated_at: "2026-03-16T06:25:28Z"
  model: gpt-5.4
  provider: openai
  source_hash: 1d7ba79fd152a978e6eb3b8f8d5dfc44cebba77d2c74dc3892aae917d32ad2ee
  source_path: providers/index.md
  workflow: 15
---

# 模型提供商

OpenClaw 可以使用许多 LLM 提供商。选择一个提供商，完成身份验证，然后将
默认模型设置为 `provider/model`。

在找聊天渠道文档（WhatsApp/Telegram/Discord/Slack/Mattermost（插件）/等）？请参见 [Channels](/channels)。

## 快速开始

1. 使用该提供商进行身份验证（通常通过 `openclaw onboard`）。
2. 设置默认模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 提供商文档

- [Amazon Bedrock](/providers/bedrock)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [GLM 模型](/providers/glm)
- [Hugging Face（Inference）](/providers/huggingface)
- [Kilocode](/providers/kilocode)
- [LiteLLM（统一网关）](/providers/litellm)
- [MiniMax](/providers/minimax)
- [Mistral](/providers/mistral)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [NVIDIA](/providers/nvidia)
- [Ollama（云端 + 本地模型）](/providers/ollama)
- [OpenAI（API + Codex）](/providers/openai)
- [OpenCode（Zen + Go）](/providers/opencode)
- [OpenRouter](/providers/openrouter)
- [Qianfan](/providers/qianfan)
- [Qwen（OAuth）](/providers/qwen)
- [Together AI](/providers/together)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Venice（Venice AI，注重隐私）](/providers/venice)
- [vLLM（本地模型）](/providers/vllm)
- [Xiaomi](/providers/xiaomi)
- [Z.AI](/providers/zai)

## 转录提供商

- [Deepgram（音频转录）](/providers/deepgram)

## 社区工具

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - 面向 Claude 订阅凭证的社区代理（使用前请核实 Anthropic 政策/条款）

有关完整的提供商目录（xAI、Groq、Mistral 等）和高级配置，
请参见 [模型提供商](/concepts/model-providers)。
