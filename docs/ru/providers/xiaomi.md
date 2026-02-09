---
summary: "Использование Xiaomi MiMo (mimo-v2-flash) с OpenClaw"
read_when:
  - Вам нужны модели Xiaomi MiMo в OpenClaw
  - Требуется настройка XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo — это API‑платформа для моделей **MiMo**. Она предоставляет REST API, совместимые с форматами
OpenAI и Anthropic, и использует ключи API для аутентификации. Создайте свой ключ API в
[консоли Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw использует
провайдер `xiaomi` с ключом API Xiaomi MiMo.

## Обзор моделей

- **mimo-v2-flash**: контекстное окно на 262 144 токена, совместимо с Anthropic Messages API.
- Базовый URL: `https://api.xiaomimimo.com/anthropic`
- Авторизация: `Bearer $XIAOMI_API_KEY`

## Настройка CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Фрагмент конфига

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Примечания

- Ссылка на модель: `xiaomi/mimo-v2-flash`.
- Провайдер внедряется автоматически, когда установлен `XIAOMI_API_KEY` (или существует профиль аутентификации).
- См. [/concepts/model-providers](/concepts/model-providers) для правил провайдеров.
