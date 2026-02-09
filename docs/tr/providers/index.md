---
summary: "OpenClaw tarafından desteklenen model sağlayıcıları (LLM'ler)"
read_when:
  - Bir model sağlayıcı seçmek istiyorsunuz
  - Desteklenen LLM arka uçlarına hızlı bir genel bakışa ihtiyacınız var
title: "Model Sağlayıcıları"
---

# Model Sağlayıcıları

OpenClaw birçok LLM sağlayıcısını kullanabilir. Bir sağlayıcı seçin, kimlik doğrulamasını yapın ve ardından
varsayılan modeli `provider/model` olarak ayarlayın.

Sohbet kanalı belgelerini mi arıyorsunuz (WhatsApp/Telegram/Discord/Slack/Mattermost (eklenti)/vb.)? [Kanallar](/channels) bölümüne bakın.

## Öne Çıkan: Venice (Venice AI)

Venice, gizlilik öncelikli çıkarım için önerdiğimiz Venice AI kurulumudur ve zor görevler için Opus kullanma seçeneği sunar.

- Varsayılan: `venice/llama-3.3-70b`
- Genel olarak en iyisi: `venice/claude-opus-45` (Opus en güçlü olmaya devam ediyor)

Bkz. [Venice AI](/providers/venice).

## Hızlı başlangıç

1. Sağlayıcıyla kimlik doğrulaması yapın (genellikle `openclaw onboard` aracılığıyla).
2. Varsayılan modeli ayarlayın:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Sağlayıcı belgeleri

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM modelleri](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, gizlilik odaklı)](/providers/venice)
- [Ollama (yerel modeller)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Transkripsiyon sağlayıcıları

- [Deepgram (ses transkripsiyonu)](/providers/deepgram)

## Topluluk araçları

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Claude Max/Pro aboneliğini OpenAI uyumlu bir API uç noktası olarak kullanın

Tüm sağlayıcı kataloğu (xAI, Groq, Mistral, vb.) ve gelişmiş yapılandırma için
[Model sağlayıcıları](/concepts/model-providers) bölümüne bakın.
