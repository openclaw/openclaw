---
summary: "Modellleverantörer (LLM:er) som stöds av OpenClaw"
read_when:
  - Du vill välja en modellleverantör
  - Du behöver en snabb översikt över stödda LLM-backends
title: "Modellleverantörer"
---

# Modellleverantörer

OpenClaw kan använda många LMM-leverantörer. Välj en leverantör, autentisera, sätt sedan
standardmodell som `provider/model`.

Letar du efter chattkanal docs (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Se [Channels](/channels).

## Höjdpunkt: Venice (Venice AI)

Venice är vår rekommenderade Venice AI-konfiguration för integritetsfokuserad inferens, med möjlighet att använda Opus för svåra uppgifter.

- Standard: `venice/llama-3.3-70b`
- Bäst totalt: `venice/claude-opus-45` (Opus är fortfarande starkast)

Se [Venice AI](/providers/venice).

## Snabbstart

1. Autentisera med leverantören (vanligtvis via `openclaw onboard`).
2. Ställ in standardmodellen:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Leverantörsdokumentation

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
- [GLM-modeller](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, integritetsfokuserad)](/providers/venice)
- [Ollama (lokala modeller)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Transkriptionsleverantörer

- [Deepgram (ljudtranskription)](/providers/deepgram)

## Community-verktyg

- [Claude Max API Proxy](/providers/claude-max-api-proxy) – Använd Claude Max/Pro-prenumeration som en OpenAI-kompatibel API-slutpunkt

För hela leverantörskatalogen (xAI, Groq, Mistral, etc.) och avancerad konfiguration,
se [Modellleverantörer](/concepts/model-providers).
