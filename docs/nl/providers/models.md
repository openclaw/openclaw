---
summary: "Modelproviders (LLM's) die door OpenClaw worden ondersteund"
read_when:
  - Je wilt een modelprovider kiezen
  - Je wilt snelle installatievoorbeelden voor LLM-authenticatie + modelselectie
title: "Snelle start voor modelproviders"
---

# Modelproviders

OpenClaw kan veel LLM-providers gebruiken. Kies er één, authenticeer en stel vervolgens
het standaardmodel in als `provider/model`.

## Uitgelicht: Venice (Venice AI)

Venice is onze aanbevolen Venice AI-installatie voor privacygerichte inferentie met een optie om Opus te gebruiken voor de moeilijkste taken.

- Standaard: `venice/llama-3.3-70b`
- Beste overall: `venice/claude-opus-45` (Opus blijft het sterkst)

Zie [Venice AI](/providers/venice).

## Snelle start (twee stappen)

1. Authenticeer bij de provider (meestal via `openclaw onboard`).
2. Stel het standaardmodel in:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Ondersteunde providers (startset)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM-modellen](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

Voor de volledige providercatalogus (xAI, Groq, Mistral, enz.) en geavanceerde configuratie,
zie [Modelproviders](/concepts/model-providers).
