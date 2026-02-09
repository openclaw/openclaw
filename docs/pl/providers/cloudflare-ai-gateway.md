---
title: "Cloudflare AI Gateway"
summary: "Konfiguracja Cloudflare AI Gateway (uwierzytelnianie + wybór modelu)"
read_when:
  - Chcesz używać Cloudflare AI Gateway z OpenClaw
  - Potrzebujesz identyfikatora konta, identyfikatora gateway lub zmiennej środowiskowej klucza API
---

# Cloudflare AI Gateway

Cloudflare AI Gateway znajduje się przed interfejsami API dostawców i umożliwia dodanie analityki, cache’owania oraz kontroli. W przypadku Anthropic OpenClaw korzysta z Anthropic Messages API za pośrednictwem punktu końcowego Gateway.

- Dostawca: `cloudflare-ai-gateway`
- Bazowy URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Domyślny model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- Klucz API: `CLOUDFLARE_AI_GATEWAY_API_KEY` (klucz API dostawcy do żądań przechodzących przez Gateway)

Dla modeli Anthropic użyj swojego klucza API Anthropic.

## Szybki start

1. Ustaw klucz API dostawcy oraz szczegóły Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Ustaw domyślny model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Nieinteraktywny przykład

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Uwierzytelnione gatewaye

Jeśli włączyłeś uwierzytelnianie Gateway w Cloudflare, dodaj nagłówek `cf-aig-authorization` (jest to dodatkiem do klucza API dostawcy).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Uwaga dotycząca środowiska

Jeśli Gateway działa jako demon (launchd/systemd), upewnij się, że `CLOUDFLARE_AI_GATEWAY_API_KEY` jest dostępne dla tego procesu (na przykład w `~/.openclaw/.env` lub poprzez `env.shellEnv`).
