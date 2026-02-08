---
summary: "Справка CLI для `openclaw onboard` (интерактивный мастер онбординга)"
read_when:
  - Вам нужна пошаговая настройка Gateway (шлюз), рабочего пространства, аутентификации, каналов и Skills
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:19Z
---

# `openclaw onboard`

Интерактивный мастер онбординга (локальная или удалённая настройка Gateway (шлюз)).

## Связанные руководства

- Центр онбординга CLI: [Onboarding Wizard (CLI)](/start/wizard)
- Справочник онбординга CLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Автоматизация CLI: [CLI Automation](/start/wizard-cli-automation)
- Онбординг в macOS: [Onboarding (macOS App)](/start/onboarding)

## Примеры

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Примечания к потоку:

- `quickstart`: минимальные запросы, автоматически генерирует токен шлюза.
- `manual`: полный набор запросов для порта/привязки/аутентификации (алиас `advanced`).
- Самый быстрый первый чат: `openclaw dashboard` (Control UI, без настройки каналов).

## Часто используемые последующие команды

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` не подразумевает неинтерактивный режим. Для скриптов используйте `--non-interactive`.
</Note>
