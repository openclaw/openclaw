---
summary: "OpenClaw がサポートするモデルプロバイダー（LLM）"
read_when:
  - モデルプロバイダーを選択したいとき
  - LLM の認証とモデル選択のクイックなセットアップ例を確認したいとき
title: "モデルプロバイダー クイックスタート"
---

# モデルプロバイダー

OpenClaw は多数の LLM プロバイダーを利用できます。1 つ選択して認証し、既定の
モデルを `provider/model` として設定します。 1つの認証を選択し、デフォルトの
モデルを`provider/model`に設定します。

## ハイライト: Venice（Venice AI）

Venice は、プライバシー重視の推論を実現するために推奨している Venice AI のセットアップです。最も難しいタスクには Opus を使用するオプションがあります。

- 既定: `venice/llama-3.3-70b`
- 総合的に最良: `venice/claude-opus-45`（Opus は依然として最強です）

[Venice AI](/providers/venice) を参照してください。

## クイックスタート（2 ステップ）

1. プロバイダーで認証します（通常は `openclaw onboard` を使用します）。
2. 既定のモデルを設定します:

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
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI）](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

完全なプロバイダカタログ（xAI、Groq、Mistralなど） そして、高度な構成、
[Model providers](/concepts/model-providers)を参照してください。
