---
read_when:
    - モデルプロバイダーを選びたい
    - サポートされているLLMバックエンドの概要を知りたい
summary: OpenClawがサポートするモデルプロバイダー（LLM）
title: プロバイダー一覧
x-i18n:
    generated_at: "2026-04-02T08:57:17Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 678ed510086b52eaa6effa90ebc049f4d34a7f87b5774013206a12f24886eeb8
    source_path: providers/index.md
    workflow: 15
---

# モデルプロバイダー

OpenClawは多くのLLMプロバイダーを利用できる。プロバイダーを選択し、認証を行い、
デフォルトのモデルを`provider/model`として設定する。

チャットチャネルのドキュメント（WhatsApp/Telegram/Discord/Slack/Mattermost（プラグイン）など）をお探しの場合は、[チャネル](/channels)を参照。

## クイックスタート

1. プロバイダーで認証する（通常は`openclaw onboard`を使用）。
2. デフォルトのモデルを設定する：

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## プロバイダードキュメント

- [Amazon Bedrock](/providers/bedrock)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [DeepSeek](/providers/deepseek)
- [GitHub Copilot](/providers/github-copilot)
- [GLM models](/providers/glm)
- [Google (Gemini)](/providers/google)
- [Groq (LPU inference)](/providers/groq)
- [Hugging Face (Inference)](/providers/huggingface)
- [Kilocode](/providers/kilocode)
- [LiteLLM (unified gateway)](/providers/litellm)
- [MiniMax](/providers/minimax)
- [Mistral](/providers/mistral)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [NVIDIA](/providers/nvidia)
- [Ollama (cloud + local models)](/providers/ollama)
- [OpenAI (API + Codex)](/providers/openai)
- [OpenCode](/providers/opencode)
- [OpenCode Go](/providers/opencode-go)
- [OpenRouter](/providers/openrouter)
- [Perplexity (web search)](/providers/perplexity-provider)
- [Qianfan](/providers/qianfan)
- [Qwen / Model Studio (Alibaba Cloud)](/providers/qwen_modelstudio)
- [SGLang (local models)](/providers/sglang)
- [Synthetic](/providers/synthetic)
- [Together AI](/providers/together)
- [Venice (Venice AI, privacy-focused)](/providers/venice)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [vLLM (local models)](/providers/vllm)
- [Volcengine (Doubao)](/providers/volcengine)
- [xAI](/providers/xai)
- [Xiaomi](/providers/xiaomi)
- [Z.AI](/providers/zai)

## 文字起こしプロバイダー

- [Deepgram (audio transcription)](/providers/deepgram)

## コミュニティツール

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claudeサブスクリプション資格情報用のコミュニティプロキシ（使用前にAnthropicのポリシー／利用規約を確認してください）

プロバイダーの完全なカタログ（xAI、Groq、Mistralなど）と高度な設定については、
[モデルプロバイダー](/concepts/model-providers)を参照。
