---
summary: "Von OpenClaw unterstützte Modellanbieter (LLMs)"
read_when:
  - Sie möchten einen Modellanbieter auswählen
  - Sie benötigen einen schnellen Überblick über unterstützte LLM-Backends
title: "Modellanbieter"
---

# Modellanbieter

OpenClaw kann viele LLM-Anbieter verwenden. Wählen Sie einen Anbieter aus, authentifizieren Sie sich und legen Sie dann das Standardmodell als `provider/model` fest.

Suchen Sie Dokumentation zu Chat-Kanälen (WhatsApp/Telegram/Discord/Slack/Mattermost (Plugin)/etc.)? Siehe [Kanäle](/channels).

## Highlight: Venice (Venice AI)

Venice ist unsere empfohlene Venice-AI-Einrichtung für datenschutzorientierte Inferenz mit der Option, Opus für anspruchsvolle Aufgaben zu verwenden.

- Standard: `venice/llama-3.3-70b`
- Insgesamt am besten: `venice/claude-opus-45` (Opus bleibt am stärksten)

Siehe [Venice AI](/providers/venice).

## Schnellstart

1. Authentifizieren Sie sich beim Anbieter (in der Regel über `openclaw onboard`).
2. Legen Sie das Standardmodell fest:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Anbieterdokumentation

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
- [GLM-Modelle](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, datenschutzorientiert)](/providers/venice)
- [Ollama (lokale Modelle)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Transkriptionsanbieter

- [Deepgram (Audio-Transkription)](/providers/deepgram)

## Community-Werkzeuge

- [Claude Max API Proxy](/providers/claude-max-api-proxy) – Verwenden Sie ein Claude-Max/Pro-Abonnement als OpenAI-kompatiblen API-Endpunkt

Für den vollständigen Anbieterkatalog (xAI, Groq, Mistral usw.) und erweiterte Konfigurationen siehe [Modellanbieter](/concepts/model-providers).
