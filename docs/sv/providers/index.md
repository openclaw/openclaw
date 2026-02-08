---
summary: "Modellleverantörer (LLM:er) som stöds av OpenClaw"
read_when:
  - Du vill välja en modellleverantör
  - Du behöver en snabb översikt över stödda LLM-backends
title: "Modellleverantörer"
x-i18n:
  source_path: providers/index.md
  source_hash: af168e89983fab19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:08Z
---

# Modellleverantörer

OpenClaw kan använda många LLM-leverantörer. Välj en leverantör, autentisera och ställ sedan in
standardmodellen som `provider/model`.

Letar du efter dokumentation för chattkanaler (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.)? Se [Kanaler](/channels).

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

För den fullständiga leverantörskatalogen (xAI, Groq, Mistral, m.fl.) och avancerad konfiguration,
se [Modellleverantörer](/concepts/model-providers).
