---
summary: "OpenClawがサポートするモデルプロバイダー（LLM）"
read_when:
  - モデルプロバイダーを選択したい場合
  - サポートされているLLMバックエンドの概要が必要な場合
title: "モデルプロバイダー"
---

# モデルプロバイダー

OpenClawは多くのLLMプロバイダーを使用できます。プロバイダーを選択し、認証してから、デフォルトモデルを `provider/model` の形式で設定してください。

チャットチャンネルのドキュメント（WhatsApp/Telegram/Discord/Slack/Mattermost（プラグイン）など）をお探しですか？[チャンネル](/channels) を参照してください。

## 注目: Venice（Venice AI）

Veniceは、プライバシーを重視した推論と、難しいタスクにOpusを使用するオプションを備えた、推奨のVenice AIセットアップです。

- デフォルト: `venice/llama-3.3-70b`
- 最高品質: `venice/claude-opus-45`（Opusは依然として最も強力）

[Venice AI](/providers/venice) を参照してください。

## クイックスタート

1. プロバイダーで認証します（通常は `openclaw onboard` を使用）。
2. デフォルトモデルを設定します:

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
- [LiteLLM（統合ゲートウェイ）](/providers/litellm)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Together AI](/providers/together)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
- [Mistral](/providers/mistral)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLMモデル](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice（Venice AI、プライバシー重視）](/providers/venice)
- [Hugging Face（推論）](/providers/huggingface)
- [Ollama（ローカルモデル）](/providers/ollama)
- [vLLM（ローカルモデル）](/providers/vllm)
- [Qianfan](/providers/qianfan)
- [NVIDIA](/providers/nvidia)

## 文字起こしプロバイダー

- [Deepgram（音声文字起こし）](/providers/deepgram)

## コミュニティツール

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/ProサブスクリプションをOpenAI互換APIエンドポイントとして使用

フルプロバイダーカタログ（xAI、Groq、Mistralなど）と高度な設定については、[モデルプロバイダー](/concepts/model-providers) を参照してください。
