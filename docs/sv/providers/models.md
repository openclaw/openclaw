---
summary: "Modellleverantörer (LLM:er) som stöds av OpenClaw"
read_when:
  - Du vill välja en modellleverantör
  - Du vill ha snabba exempel för LLM-autentisering + modellval
title: "Snabbstart för modellleverantörer"
x-i18n:
  source_path: providers/models.md
  source_hash: 691d2c97ef6b01cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:14Z
---

# Modellleverantörer

OpenClaw kan använda många LLM-leverantörer. Välj en, autentisera och ställ sedan in standardmodellen som `provider/model`.

## Höjdpunkt: Venice (Venice AI)

Venice är vår rekommenderade Venice AI-konfiguration för integritetsfokuserad inferens, med möjlighet att använda Opus för de svåraste uppgifterna.

- Standard: `venice/llama-3.3-70b`
- Bäst totalt sett: `venice/claude-opus-45` (Opus är fortfarande starkast)

Se [Venice AI](/providers/venice).

## Snabbstart (två steg)

1. Autentisera med leverantören (vanligtvis via `openclaw onboard`).
2. Ställ in standardmodellen:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Stödda leverantörer (startuppsättning)

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

För den fullständiga leverantörskatalogen (xAI, Groq, Mistral m.fl.) och avancerad konfiguration, se [Model providers](/concepts/model-providers).
