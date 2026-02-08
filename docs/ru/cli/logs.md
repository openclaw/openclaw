---
summary: "Справка CLI для `openclaw logs` (просмотр логов Gateway (шлюза) в реальном времени через RPC)"
read_when:
  - Вам нужно просматривать логи Gateway (шлюза) удалённо (без SSH)
  - Вам нужны строки логов в формате JSON для инструментов
title: "логи"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:17Z
---

# `openclaw logs`

Следить в реальном времени за файловыми логами Gateway (шлюза) по RPC (работает в удалённом режиме).

Связанное:

- Обзор логирования: [Logging](/logging)

## Примеры

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
