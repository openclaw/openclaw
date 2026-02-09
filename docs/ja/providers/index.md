---
summary: "OpenClaw がサポートするモデルプロバイダー（LLM）"
read_when:
  - モデルプロバイダーを選択したい場合
  - サポートされている LLM バックエンドの概要を素早く把握したい場合
title: "モデルプロバイダー"
---

# モデルプロバイダー

OpenClaw は多くの LLM プロバイダーを使用できます。プロバイダーを選択して認証し、既定のモデルを `provider/model` として設定してください。 プロバイダを選択し、認証し、
デフォルトモデルを`provider/model`に設定します。

チャットチャンネルのドキュメント（WhatsApp/Telegram/Discord/Slack/Mattermost（プラグイン）/など）をお探しですか？ [Channels](/channels) を参照してください。 [Channels](/channels) を参照してください。

## ハイライト：Venice（Venice AI）

Venice は、プライバシー重視の推論向けに推奨している Venice AI のセットアップです。難易度の高いタスクでは Opus を使用する選択肢があります。

- 既定：`venice/llama-3.3-70b`
- 総合的に最良：`venice/claude-opus-45`（Opus は依然として最も強力です）

詳細は [Venice AI](/providers/venice) を参照してください。

## クイックスタート

1. プロバイダーで認証します（通常は `openclaw onboard` を使用します）。
2. 既定のモデルを設定します：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## プロバイダードキュメント

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
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI、プライバシー重視）](/providers/venice)
- [Ollama（ローカルモデル）](/providers/ollama)
- [Qianfan](/providers/qianfan)

## 文字起こしプロバイダー

- [Deepgram（音声文字起こし）](/providers/deepgram)

## コミュニティツール

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro サブスクリプションを OpenAI 互換の API エンドポイントとして使用します

完全なプロバイダカタログ（xAI、Groq、Mistralなど） そして、高度な構成、
[Model providers](/concepts/model-providers)を参照してください。
