---
summary: "Справочник CLI для `openclaw security` (аудит и исправление распространённых проблем безопасности)"
read_when:
  - Вы хотите выполнить быстрый аудит безопасности конфигурации/состояния
  - Вы хотите применить безопасные рекомендации «fix» (chmod, ужесточение значений по умолчанию)
title: "security"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:17Z
---

# `openclaw security`

Инструменты безопасности (аудит + необязательные исправления).

Связанное:

- Руководство по безопасности: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Аудит предупреждает, когда несколько отправителей личных сообщений (DM) используют основной сеанс, и рекомендует **безопасный режим DM**: `session.dmScope="per-channel-peer"` (или `per-account-channel-peer` для каналов с несколькими аккаунтами) для общих входящих.
Также он предупреждает, когда небольшие модели (`<=300B`) используются без sandboxing и с включёнными веб/браузерными инструментами.
