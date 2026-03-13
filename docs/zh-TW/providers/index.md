---
summary: Model providers (LLMs) supported by OpenClaw
read_when:
  - You want to choose a model provider
  - You need a quick overview of supported LLM backends
title: Model Providers
---

# 模型提供者

OpenClaw 可以使用多種大型語言模型（LLM）提供者。選擇一個提供者，完成驗證，然後將預設模型設為 `provider/model`。

想找聊天頻道文件（WhatsApp/Telegram/Discord/Slack/Mattermost（外掛）等）？請參考 [Channels](/channels)。

## 快速開始

1. 與提供者驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 提供者文件

- [Amazon Bedrock](/providers/bedrock)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [GLM 模型](/providers/glm)
- [Hugging Face (推論)](/providers/huggingface)
- [Kilocode](/providers/kilocode)
- [LiteLLM（統一閘道）](/providers/litellm)
- [MiniMax](/providers/minimax)
- [Mistral](/providers/mistral)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [NVIDIA](/providers/nvidia)
- [Ollama（雲端 + 本地模型）](/providers/ollama)
- [OpenAI (API + Codex)](/providers/openai)
- [OpenCode (Zen + Go)](/providers/opencode)
- [OpenRouter](/providers/openrouter)
- [千帆](/providers/qianfan)
- [Qwen (OAuth)](/providers/qwen)
- [Together AI](/providers/together)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Venice（Venice AI，注重隱私）](/providers/venice)
- [vLLM（本地模型）](/providers/vllm)
- [小米](/providers/xiaomi)
- [Z.AI](/providers/zai)

## 轉錄提供者

- [Deepgram（音訊轉錄）](/providers/deepgram)

## 社群工具

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude 訂閱憑證的社群代理（使用前請確認 Anthropic 政策/條款）

完整的提供者目錄（xAI、Groq、Mistral 等）及進階設定，請參考 [Model providers](/concepts/model-providers)。
