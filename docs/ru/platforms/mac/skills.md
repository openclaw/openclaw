---
summary: "Интерфейс настроек Skills для macOS и статус, поддерживаемый Gateway (шлюзом)"
read_when:
  - Обновление интерфейса настроек Skills для macOS
  - Изменение ограничений Skills или поведения установки
title: "Skills"
x-i18n:
  source_path: platforms/mac/skills.md
  source_hash: ecd5286bbe49eed8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:46Z
---

# Skills (macOS)

Приложение для macOS отображает Skills OpenClaw через Gateway (шлюз); локального парсинга Skills не выполняется.

## Data source

- `skills.status` (Gateway (шлюз)) возвращает все Skills, а также сведения о допустимости и отсутствующих требованиях
  (включая блокировки списка разрешённых для Skills, поставляемых в комплекте).
- Требования формируются на основе `metadata.openclaw.requires` в каждом `SKILL.md`.

## Install actions

- `metadata.openclaw.install` определяет варианты установки (brew/node/go/uv).
- Приложение вызывает `skills.install` для запуска установщиков на хосте шлюза Gateway.
- Gateway (шлюз) предоставляет только один предпочтительный установщик, когда доступно несколько
  (brew при наличии, иначе менеджер node из `skills.install`, по умолчанию npm).

## Env/API keys

- Приложение хранит ключи в `~/.openclaw/openclaw.json` под `skills.entries.<skillKey>`.
- `skills.update` вносит изменения в `enabled`, `apiKey` и `env`.

## Remote mode

- Установка и обновления конфигурации выполняются на хосте шлюза Gateway (а не на локальном Mac).
