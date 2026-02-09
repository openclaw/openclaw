---
title: "Vercel AI Gateway"
summary: "Настройка Vercel AI Gateway (аутентификация + выбор модели)"
read_when:
  - Вы хотите использовать Vercel AI Gateway с OpenClaw
  - Вам нужен ключ API в переменной окружения или выбор аутентификации через CLI
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) предоставляет единый API для доступа к сотням моделей через одну конечную точку.

- Провайдер: `vercel-ai-gateway`
- Аутентификация: `AI_GATEWAY_API_KEY`
- API: совместимый с Anthropic Messages

## Быстрый старт

1. Установите ключ API (рекомендуется: сохранить его для Gateway (шлюз)):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Установите модель по умолчанию:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Неинтерактивный пример

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Примечание по окружению

Если Gateway (шлюз) работает как демон (launchd/systemd), убедитесь, что `AI_GATEWAY_API_KEY`
доступна этому процессу (например, в `~/.openclaw/.env` или через
`env.shellEnv`).
