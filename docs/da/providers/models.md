---
summary: "Modeludbydere (LLM'er) understøttet af OpenClaw"
read_when:
  - Du vil vælge en modeludbyder
  - Du vil have hurtige opsætningseksempler til LLM-autentificering + modelvalg
title: "Hurtig start for modeludbydere"
x-i18n:
  source_path: providers/models.md
  source_hash: 691d2c97ef6b01cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:29Z
---

# Modeludbydere

OpenClaw kan bruge mange LLM-udbydere. Vælg én, autentificér, og angiv derefter standardmodellen som `provider/model`.

## Fremhævet: Venice (Venice AI)

Venice er vores anbefalede Venice AI-opsætning til privatlivsorienteret inferens med mulighed for at bruge Opus til de sværeste opgaver.

- Standard: `venice/llama-3.3-70b`
- Bedst samlet set: `venice/claude-opus-45` (Opus er fortsat den stærkeste)

Se [Venice AI](/providers/venice).

## Hurtig start (to trin)

1. Autentificér med udbyderen (typisk via `openclaw onboard`).
2. Angiv standardmodellen:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Understøttede udbydere (startudvalg)

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

For det fulde udbyderkatalog (xAI, Groq, Mistral m.fl.) og avanceret konfiguration,
se [Modeludbydere](/concepts/model-providers).
