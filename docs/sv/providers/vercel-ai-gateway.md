---
title: "Vercel AI Gateway"
summary: "Konfigurering av Vercel AI Gateway (autentisering + modellval)"
read_when:
  - Du vill använda Vercel AI Gateway med OpenClaw
  - Du behöver API-nyckelns miljövariabel eller CLI-alternativ för autentisering
x-i18n:
  source_path: providers/vercel-ai-gateway.md
  source_hash: 2bf1687c1152c6e1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:11Z
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) tillhandahåller ett enhetligt API för att få åtkomst till hundratals modeller via en enda endpoint.

- Leverantör: `vercel-ai-gateway`
- Autentisering: `AI_GATEWAY_API_KEY`
- API: Kompatibelt med Anthropic Messages

## Snabbstart

1. Ställ in API-nyckeln (rekommenderat: lagra den för Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Ställ in en standardmodell:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Icke-interaktivt exempel

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Miljönotering

Om Gateway körs som en daemon (launchd/systemd), se till att `AI_GATEWAY_API_KEY`
är tillgänglig för den processen (till exempel i `~/.openclaw/.env` eller via
`env.shellEnv`).
