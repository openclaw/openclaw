---
title: "Vercel AI Gateway"
summary: "Installatie van Vercel AI Gateway (authenticatie + modelselectie)"
read_when:
  - Je wilt Vercel AI Gateway gebruiken met OpenClaw
  - Je hebt de API-sleutel-omgevingsvariabele of de CLI-authenticatiekeuze nodig
---

# Vercel AI Gateway

De [Vercel AI Gateway](https://vercel.com/ai-gateway) biedt een uniforme API om toegang te krijgen tot honderden modellen via één enkel eindpunt.

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages-compatibel

## Snelle start

1. Stel de API-sleutel in (aanbevolen: sla deze op voor de Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Stel een standaardmodel in:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Niet-interactief voorbeeld

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Omgevingsnotitie

Als de Gateway als daemon draait (launchd/systemd), zorg er dan voor dat `AI_GATEWAY_API_KEY`
beschikbaar is voor dat proces (bijvoorbeeld in `~/.openclaw/.env` of via
`env.shellEnv`).
