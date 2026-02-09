---
summary: "OpenClaw tarafından desteklenen model sağlayıcıları (LLM'ler)"
read_when:
  - Bir model sağlayıcısı seçmek istiyorsanız
  - LLM kimlik doğrulaması + model seçimi için hızlı kurulum örnekleri istiyorsanız
title: "Model Sağlayıcısı Hızlı Başlangıç"
---

# Model Sağlayıcıları

OpenClaw birçok LLM sağlayıcısını kullanabilir. Birini seçin, kimlik doğrulamasını yapın ve ardından varsayılan
modeli `provider/model` olarak ayarlayın.

## Öne Çıkan: Venice (Venice AI)

Venice, gizlilik öncelikli çıkarım için önerdiğimiz Venice AI kurulumudur ve en zor görevler için Opus kullanma seçeneği sunar.

- Varsayılan: `venice/llama-3.3-70b`
- Genel olarak en iyi: `venice/claude-opus-45` (Opus en güçlü olmaya devam ediyor)

Bkz. [Venice AI](/providers/venice).

## Hızlı başlangıç (iki adım)

1. Sağlayıcıyla kimlik doğrulaması yapın (genellikle `openclaw onboard` aracılığıyla).
2. Varsayılan modeli ayarlayın:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Desteklenen sağlayıcılar (başlangıç seti)

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

Tüm sağlayıcı kataloğu (xAI, Groq, Mistral vb.) ve gelişmiş yapılandırma için
bkz. [Model sağlayıcıları](/concepts/model-providers).
