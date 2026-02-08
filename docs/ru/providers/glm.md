---
summary: "Обзор семейства моделей GLM и способы их использования в OpenClaw"
read_when:
  - Вам нужны модели GLM в OpenClaw
  - Вам требуется соглашение об именовании моделей и настройка
title: "Модели GLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:47Z
---

# Модели GLM

GLM — это **семейство моделей** (а не компания), доступное через платформу Z.AI. В OpenClaw к моделям GLM обращаются через провайдер `zai` и идентификаторы моделей вида `zai/glm-4.7`.

## Настройка CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Фрагмент конфига

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Примечания

- Версии GLM и их доступность могут меняться; актуальную информацию проверяйте в документации Z.AI.
- Примеры идентификаторов моделей: `glm-4.7` и `glm-4.6`.
- Подробности о провайдере см. [/providers/zai](/providers/zai).
