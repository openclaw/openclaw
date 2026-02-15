---
summary: "OpenClaw 支援的模型供應商 (LLM)"
read_when:
  - 您想要選擇模型供應商
  - 您想要 LLM 驗證與模型選擇的快速設定範例
title: "模型供應商快速開始"
---

# 模型供應商

OpenClaw 可以使用多種 LLM 供應商。選擇一個、進行驗證，然後將預設模型設定為 `provider/model`。

## 重點介紹：Venice (Venice AI)

Venice 是我們推薦的 Venice AI 設定，專為隱私優先的推論而設計，並提供在執行最艱難任務時使用 Opus 的選項。

- 預設：`venice/llama-3.3-70b`
- 整體最佳：`venice/claude-opus-45` (Opus 依然最強大)

參閱 [Venice AI](/providers/venice)。

## 快速開始（兩個步驟）

1. 與供應商進行驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 支援的供應商（入門組）

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

若要查看完整的供應商目錄（xAI、Groq、Mistral 等）與進階設定，請參閱 [模型供應商](/concepts/model-providers)。
