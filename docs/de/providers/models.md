---
summary: "Von OpenClaw unterstützte Modellanbieter (LLMs)"
read_when:
  - Sie möchten einen Modellanbieter auswählen
  - Sie möchten schnelle Einrichtungsbeispiele für LLM-Authentifizierung und Modellauswahl
title: "Schnellstart für Modellanbieter"
---

# Modellanbieter

OpenClaw kann viele LLM-Anbieter verwenden. Wählen Sie einen aus, authentifizieren Sie sich und legen Sie dann das Standardmodell als `provider/model` fest.

## Highlight: Venice (Venice AI)

Venice ist unser empfohlener Venice-AI-Setup für datenschutzorientierte Inferenz mit der Option, Opus für die anspruchsvollsten Aufgaben zu verwenden.

- Standard: `venice/llama-3.3-70b`
- Insgesamt am besten: `venice/claude-opus-45` (Opus bleibt das stärkste Modell)

Siehe [Venice AI](/providers/venice).

## Schnellstart (zwei Schritte)

1. Authentifizieren Sie sich beim Anbieter (in der Regel über `openclaw onboard`).
2. Legen Sie das Standardmodell fest:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Unterstützte Anbieter (Starter-Set)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM-Modelle](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

Den vollständigen Anbieterkatalog (xAI, Groq, Mistral usw.) sowie erweiterte Konfigurationen finden Sie unter [Modellanbieter](/concepts/model-providers).
