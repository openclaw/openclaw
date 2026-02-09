---
summary: "Использование OpenAI через ключи API или подписку Codex в OpenClaw"
read_when:
  - Вы хотите использовать модели OpenAI в OpenClaw
  - Вам нужна аутентификация по подписке Codex вместо ключей API
title: "OpenAI"
---

# OpenAI

OpenAI предоставляет API для разработчиков для моделей GPT. Codex поддерживает **вход через ChatGPT** для доступа по подписке
или **вход по ключу API** для доступа с оплатой по факту использования. Облачный Codex требует входа через ChatGPT.

## Вариант A: ключ API OpenAI (платформа OpenAI)

**Лучше всего подходит для:** прямого доступа к API и биллинга по факту использования.
Получите ключ API на панели управления OpenAI.

### Настройка CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Фрагмент конфига

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Вариант B: подписка OpenAI Code (Codex)

**Лучше всего подходит для:** использования доступа по подписке ChatGPT/Codex вместо ключа API.
Облачный Codex требует входа через ChatGPT, тогда как Codex CLI поддерживает вход через ChatGPT или по ключу API.

### Настройка CLI (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Фрагмент конфига (подписка Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Примечания

- Ссылки на модели всегда используют `provider/model` (см. [/concepts/models](/concepts/models)).
- Сведения об аутентификации и правила повторного использования приведены в [/concepts/oauth](/concepts/oauth).
