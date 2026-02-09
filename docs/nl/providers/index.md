---
summary: "Modelproviders (LLM's) die door OpenClaw worden ondersteund"
read_when:
  - Je wilt een modelprovider kiezen
  - Je hebt een snel overzicht nodig van ondersteunde LLM-backends
title: "Modelproviders"
---

# Modelproviders

OpenClaw kan veel LLM-providers gebruiken. Kies een provider, authenticeer en stel vervolgens
het standaardmodel in als `provider/model`.

Op zoek naar documentatie over chatkanalen (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Zie [Kanalen](/channels).

## Highlight: Venice (Venice AI)

Venice is onze aanbevolen Venice AI-configuratie voor privacy-first inferentie met een optie om Opus te gebruiken voor zware taken.

- Standaard: `venice/llama-3.3-70b`
- Beste overall: `venice/claude-opus-45` (Opus blijft de sterkste)

Zie [Venice AI](/providers/venice).

## Snelle start

1. Authenticeer bij de provider (meestal via `openclaw onboard`).
2. Stel het standaardmodel in:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Providerdocumentatie

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
- [GLM-modellen](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, privacygericht)](/providers/venice)
- [Ollama (lokale modellen)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Transcriptieproviders

- [Deepgram (audiotranscriptie)](/providers/deepgram)

## Communitytools

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Gebruik een Claude Max/Pro-abonnement als een OpenAI-compatibel API-eindpunt

Voor de volledige providercatalogus (xAI, Groq, Mistral, enz.) en geavanceerde configuratie,
zie [Modelproviders](/concepts/model-providers).
