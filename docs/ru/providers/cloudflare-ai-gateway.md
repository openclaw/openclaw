---
title: "Cloudflare AI Gateway"
summary: "Настройка Cloudflare AI Gateway (аутентификация + выбор модели)"
read_when:
  - Вы хотите использовать Cloudflare AI Gateway с OpenClaw
  - Вам нужен ID аккаунта, ID Gateway или переменная окружения с ключом API
---

# Cloudflare AI Gateway

Cloudflare AI Gateway располагается перед API провайдеров и позволяет добавлять аналитику, кэширование и элементы управления. Для Anthropic OpenClaw использует Anthropic Messages API через ваш endpoint Gateway.

- Провайдер: `cloudflare-ai-gateway`
- Базовый URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Модель по умолчанию: `cloudflare-ai-gateway/claude-sonnet-4-5`
- Ключ API: `CLOUDFLARE_AI_GATEWAY_API_KEY` (ключ API вашего провайдера для запросов через Gateway)

Для моделей Anthropic используйте ваш ключ API Anthropic.

## Быстрый старт

1. Установите ключ API провайдера и параметры Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Установите модель по умолчанию:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Пример без интерактивного ввода

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Аутентифицированные Gateway

Если вы включили аутентификацию Gateway в Cloudflare, добавьте заголовок `cf-aig-authorization` (это в дополнение к ключу API вашего провайдера).

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

## Примечание по окружению

Если Gateway запускается как демон (launchd/systemd), убедитесь, что `CLOUDFLARE_AI_GATEWAY_API_KEY` доступна этому процессу (например, в `~/.openclaw/.env` или через `env.shellEnv`).
