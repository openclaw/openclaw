---
summary: "Заметки по RPC‑протоколу для мастера онбординга и схемы конфига"
read_when: "При изменении шагов мастера онбординга или эндпоинтов схемы конфига"
title: "Протокол онбординга и конфига"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:29Z
---

# Протокол онбординга и конфига

Назначение: общие поверхности онбординга и конфига для CLI, приложения для macOS и веб‑интерфейса.

## Компоненты

- Движок мастера (общий сеанс + подсказки + состояние онбординга).
- Онбординг в CLI использует тот же поток мастера, что и UI‑клиенты.
- RPC шлюза Gateway предоставляет эндпоинты мастера и схемы конфига.
- Онбординг в macOS использует модель шагов мастера.
- Веб‑интерфейс рендерит формы конфига из JSON Schema + подсказок UI.

## RPC шлюза Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Ответы (форма)

- Мастер: `{ sessionId, done, step?, status?, error? }`
- Схема конфига: `{ schema, uiHints, version, generatedAt }`

## Подсказки UI

- `uiHints` с ключами по пути; необязательные метаданные (label/help/group/order/advanced/sensitive/placeholder).
- Чувствительные поля отображаются как поля ввода пароля; слоя редактирования нет.
- Неподдерживаемые узлы схемы откатываются к «сырому» редактору JSON.

## Примечания

- Этот документ — единое место для отслеживания рефакторингов протокола онбординга/конфига.
