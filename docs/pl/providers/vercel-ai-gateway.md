---
title: "Vercel AI Gateway"
summary: "Konfiguracja Vercel AI Gateway (uwierzytelnianie + wybór modelu)"
read_when:
  - Chcesz używać Vercel AI Gateway z OpenClaw
  - Potrzebujesz zmiennej środowiskowej klucza API lub wyboru uwierzytelniania w CLI
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) zapewnia ujednolicone API umożliwiające dostęp do setek modeli przez jeden punkt końcowy.

- Dostawca: `vercel-ai-gateway`
- Uwierzytelnianie: `AI_GATEWAY_API_KEY`
- API: zgodne z Anthropic Messages

## Szybki start

1. Ustaw klucz API (zalecane: zapisz go dla Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Ustaw domyślny model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Przykład bez interakcji

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Uwaga dotycząca środowiska

Jeśli Gateway działa jako demon (launchd/systemd), upewnij się, że `AI_GATEWAY_API_KEY`
jest dostępne dla tego procesu (na przykład w `~/.openclaw/.env` lub poprzez
`env.shellEnv`).
