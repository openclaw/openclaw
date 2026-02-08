---
summary: "Справка CLI для `openclaw doctor` (проверки состояния + пошаговые исправления)"
read_when:
  - У вас есть проблемы с подключением/аутентификацией и вы хотите пошаговые исправления
  - Вы обновились и хотите выполнить проверку корректности
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:16Z
---

# `openclaw doctor`

Проверки состояния + быстрые исправления для шлюза Gateway и каналов.

Связанное:

- Устранение неполадок: [Troubleshooting](/gateway/troubleshooting)
- Аудит безопасности: [Security](/gateway/security)

## Примеры

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Примечания:

- Интерактивные запросы (например, исправления keychain/OAuth) выполняются только когда stdin — TTY и `--non-interactive` **не** установлен. Запуски без терминала (cron, Telegram, без терминала) пропускают запросы.
- `--fix` (псевдоним для `--repair`) записывает резервную копию в `~/.openclaw/openclaw.json.bak` и удаляет неизвестные ключи конфига, перечисляя каждое удаление.

## macOS: переопределения переменных окружения `launchctl`

Если вы ранее запускали `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (или `...PASSWORD`), это значение переопределяет ваш конфиг‑файл и может вызывать устойчивые ошибки «неавторизован».

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
