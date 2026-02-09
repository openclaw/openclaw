---
summary: "OpenClaw 支援的模型提供者（LLM）"
read_when:
  - 你想要選擇模型提供者
  - 你想要快速設定 LLM 身分驗證與模型選擇的範例
title: "模型提供者快速入門"
---

# 模型提供者

OpenClaw can use many LLM providers. 30. 選擇其中一個，完成驗證，然後將預設
模型設為 `provider/model`。

## 重點：Venice（Venice AI）

Venice 是我們建議的 Venice AI 設定，主打隱私優先的推論，並可在最困難的任務中選用 Opus。

- 預設：`venice/llama-3.3-70b`
- 整體最佳：`venice/claude-opus-45`（Opus 仍然最強）

請參閱 [Venice AI](/providers/venice)。

## 快速開始（兩個步驟）

1. 與提供者完成身分驗證（通常透過 `openclaw onboard`）。
2. 設定預設模型：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 支援的提供者（入門組）

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI）](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
