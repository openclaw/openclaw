---
summary: "Modeludbydere (LLM'er) understøttet af OpenClaw"
read_when:
  - Du vil vælge en modeludbyder
  - Du har brug for et hurtigt overblik over understøttede LLM-backends
title: "Modeludbydere"
x-i18n:
  source_path: providers/index.md
  source_hash: af168e89983fab19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:30Z
---

# Modeludbydere

OpenClaw kan bruge mange LLM-udbydere. Vælg en udbyder, autentificér, og sæt derefter
standardmodellen som `provider/model`.

Leder du efter dokumentation til chatkanaler (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/osv.)? Se [Kanaler](/channels).

## Highlight: Venice (Venice AI)

Venice er vores anbefalede Venice AI-opsætning til privatlivs-først-inferens med mulighed for at bruge Opus til krævende opgaver.

- Standard: `venice/llama-3.3-70b`
- Bedst samlet set: `venice/claude-opus-45` (Opus er fortsat den stærkeste)

Se [Venice AI](/providers/venice).

## Hurtig start

1. Autentificér med udbyderen (normalt via `openclaw onboard`).
2. Sæt standardmodellen:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Udbyderdokumentation

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
- [Venice (Venice AI, privatlivsfokuseret)](/providers/venice)
- [Ollama (lokale modeller)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Transskriptionsudbydere

- [Deepgram (lydtransskription)](/providers/deepgram)

## Community-værktøjer

- [Claude Max API Proxy](/providers/claude-max-api-proxy) – Brug Claude Max/Pro-abonnement som et OpenAI-kompatibelt API-endpoint

For det fulde udbyderkatalog (xAI, Groq, Mistral osv.) og avanceret konfiguration,
se [Modeludbydere](/concepts/model-providers).
