---
summary: Model providers (LLMs) supported by OpenClaw
read_when:
  - You want to choose a model provider
  - You want quick setup examples for LLM auth + model selection
title: Model Provider Quickstart
---

# 模型提供者

OpenClaw 可以使用多種大型語言模型（LLM）提供者。選擇一個，進行驗證，然後將預設模型設為 `provider/model`。

## 快速開始（兩步驟）

1. 與提供者驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 支援的提供者（入門組合）

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
- [千帆](/providers/qianfan)

欲查看完整提供者目錄（xAI、Groq、Mistral 等）及進階設定，請參考 [模型提供者](/concepts/model-providers)。
