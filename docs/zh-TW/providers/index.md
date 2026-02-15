---
summary: "OpenClaw 支援的模型供應商 (LLM)"
read_when:
  - 您想要選擇模型供應商
  - 您需要快速了解支援的 LLM 後端
title: "模型供應商"
---

# 模型供應商

OpenClaw 可以使用多種 LLM 供應商。選擇一個供應商，進行驗證，然後將預設模型設定為 `provider/model`。

正在尋找通訊頻道文件（WhatsApp/Telegram/Discord/Slack/Mattermost (外掛程式) 等）？請參閱 [頻道](/channels)。

## 重點推薦：Venice (Venice AI)

Venice 是我們推薦的 Venice AI 設定，適用於隱私優先的推論，並可選擇在處理困難任務時使用 Opus。

- 預設：`venice/llama-3.3-70b`
- 最佳綜合表現：`venice/claude-opus-45` (Opus 依然是最強大的)

請參閱 [Venice AI](/providers/venice)。

## 快速開始

1. 向供應商進行驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 供應商文件

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [LiteLLM (統一 Gateway)](/providers/litellm)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Together AI](/providers/together)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM 模型](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI，專注隱私)](/providers/venice)
- [Hugging Face (推論)](/providers/huggingface)
- [Ollama (本地模型)](/providers/ollama)
- [vLLM (本地模型)](/providers/vllm)
- [Qianfan](/providers/qianfan)

## 逐字稿供應商

- [Deepgram (音訊轉寫)](/providers/deepgram)

## 社群工具

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - 將 Claude Max/Pro 訂閱作為與 OpenAI 相容的 API 端點使用

有關完整的供應商目錄 (xAI, Groq, Mistral 等) 與進階設定，請參閱 [模型供應商](/concepts/model-providers)。
