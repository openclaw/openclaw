---
summary: "OpenClaw 支援的模型提供者（LLM）"
read_when:
  - 你想要選擇模型提供者
  - 你需要快速概覽支援的 LLM 後端
title: "模型提供者"
---

# 模型提供者

OpenClaw can use many LLM providers. Pick a provider, authenticate, then set the
default model as `provider/model`.

在找聊天頻道文件（WhatsApp／Telegram／Discord／Slack／Mattermost（外掛）／等）嗎？請參閱 [頻道](/channels)。 See [Channels](/channels).

## 重點推薦：Venice（Venice AI）

Venice 是我們推薦的 Venice AI 設定，提供以隱私優先的推論，並可選擇在高難度任務中使用 Opus。

- 預設：`venice/llama-3.3-70b`
- 整體最佳：`venice/claude-opus-45`（Opus 仍然最強）

請參閱 [Venice AI](/providers/venice)。

## 快速開始

1. 使用提供者完成身分驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 提供者文件

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [Qwen（OAuth）](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI，隱私導向）](/providers/venice)
- [Ollama（本地模型）](/providers/ollama)
- [Qianfan](/providers/qianfan)

## 轉錄提供者

- [Deepgram（音訊轉錄）](/providers/deepgram)

## 社群工具

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - 將 Claude Max／Pro 訂閱作為相容 OpenAI 的 API 端點使用

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
