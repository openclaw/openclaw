---
summary: "OpenClaw 支援的模型供應商 (LLM)"
read_when:
  - 您想選擇模型供應商時
  - 您想快速了解 LLM 憑證設定與模型選擇範例時
title: "模型供應商快速開始"
---

# 模型供應商

OpenClaw 可以使用多個 LLM 供應商。請選擇一個，進行憑證驗證，然後將預設模型設定為 `provider/model`。

## 焦點：Venice (Venice AI)

Venice 是我們推薦的 Venice AI 設定，可優先考慮隱私推論，並可選擇使用 Opus 處理最困難的任務。

- Default: `venice/llama-3.3-70b`
- Best overall: `venice/claude-opus-45` (Opus 仍然最強大)

請參閱 [Venice AI](/providers/venice)。

## 快速開始（兩步驟）

1. 向供應商進行憑證驗證 (通常透過 `openclaw onboard`)。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 支援的供應商（入門套件）

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

如需完整的供應商目錄 (xAI、Groq、Mistral 等) 以及進階設定，請參閱[模型供應商](/concepts/model-providers)。
