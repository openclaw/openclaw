---
summary: "Использование Z.AI (моделей GLM) с OpenClaw"
read_when:
  - Вам нужны модели Z.AI / GLM в OpenClaw
  - Вам требуется простая настройка ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI — это платформа API для моделей **GLM**. Она предоставляет REST API для GLM и использует ключи API
для аутентификации. Создайте свой ключ API в консоли Z.AI. OpenClaw использует провайдер `zai` с
ключом API Z.AI.

## настройка CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## фрагмент конфига

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Примечания

- Модели GLM доступны как `zai/<model>` (пример: `zai/glm-4.7`).
- См. [/providers/glm](/providers/glm) для обзора семейства моделей.
- Z.AI использует Bearer-аутентификацию с вашим ключом API.
