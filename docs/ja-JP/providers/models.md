---
read_when:
    - モデルプロバイダーを選びたい場合
    - LLM の認証 + モデル選択のクイックセットアップ例が必要な場合
summary: OpenClaw がサポートするモデルプロバイダー（LLM）
title: モデルプロバイダー クイックスタート
x-i18n:
    generated_at: "2026-04-02T08:58:05Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4a11ca3212087bd4cec6662cd4a2b83a10f6bb33e87b556ceebb8c8ba29c19f3
    source_path: providers/models.md
    workflow: 15
---

# モデルプロバイダー

OpenClaw は多くの LLM プロバイダーを使用できます。1つを選び、認証を行い、デフォルトモデルを `provider/model` の形式で設定します。

## クイックスタート（2ステップ）

1. プロバイダーで認証します（通常は `openclaw onboard` を使用）。
2. デフォルトモデルを設定します:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## サポートされているプロバイダー（スターターセット）

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Mistral](/providers/mistral)
- [Synthetic](/providers/synthetic)
- [OpenCode (Zen + Go)](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)
- [xAI](/providers/xai)

完全なプロバイダーカタログ（xAI、Groq、Mistral など）と高度な設定については、[モデルプロバイダー](/concepts/model-providers)を参照してください。
