---
title: "Vercel AI Gateway"
summary: "Konfigurering av Vercel AI Gateway (autentisering + modellval)"
read_when:
  - Du vill använda Vercel AI Gateway med OpenClaw
  - Du behöver API-nyckelns miljövariabel eller CLI-alternativ för autentisering
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
