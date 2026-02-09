---
title: "Vercel AI Gateway"
summary: "Opsætning af Vercel AI Gateway (autentificering + modelvalg)"
read_when:
  - Du vil bruge Vercel AI Gateway med OpenClaw
  - Du har brug for API-nøglens miljøvariabel eller CLI-valg for autentificering
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) leverer et samlet API til at få adgang til hundredvis af modeller via et enkelt endpoint.

- Udbyder: `vercel-ai-gateway`
- Autentificering: `AI_GATEWAY_API_KEY`
- API: Kompatibel med Anthropic Messages

## Hurtig start

1. Sæt API-nøglen (anbefalet: gem den til Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Vælg en standardmodel:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Ikke-interaktivt eksempel

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Miljønote

Hvis Gateway kører som en daemon (launchd/systemd), skal du sikre, at `AI_GATEWAY_API_KEY`
er tilgængelig for den proces (for eksempel i `~/.openclaw/.env` eller via
`env.shellEnv`).
