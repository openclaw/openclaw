---
summary: "OpenClawがサポートするモデルプロバイダー（LLM）"
read_when:
  - モデルプロバイダーを選択したい場合
  - LLM認証とモデル選択のクイックセットアップ例が必要な場合
title: "モデルプロバイダークイックスタート"
---

# モデルプロバイダー

OpenClawは多くのLLMプロバイダーを使用できます。プロバイダーを一つ選択し、認証してから、デフォルトモデルを `provider/model` の形式で設定してください。

## 注目: Venice（Venice AI）

Veniceは、プライバシーを重視した推論と、最も難しいタスクにOpusを使用するオプションを備えた、推奨のVenice AIセットアップです。

- デフォルト: `venice/llama-3.3-70b`
- 最高品質: `venice/claude-opus-45`（Opusは依然として最も強力）

[Venice AI](/providers/venice) を参照してください。

## クイックスタート（2ステップ）

1. プロバイダーで認証します（通常は `openclaw onboard` を使用）。
2. デフォルトモデルを設定します:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## サポートされているプロバイダー（スターターセット）

- [OpenAI（API + Codex）](/providers/openai)
- [Anthropic（API + Claude Code CLI）](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [Mistral](/providers/mistral)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLMモデル](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI）](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

フルプロバイダーカタログ（xAI、Groq、Mistralなど）と高度な設定については、[モデルプロバイダー](/concepts/model-providers) を参照してください。
