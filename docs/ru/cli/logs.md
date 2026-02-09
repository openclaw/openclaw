---
summary: "Справка CLI для `openclaw logs` (просмотр логов Gateway (шлюза) в реальном времени через RPC)"
read_when:
  - Вам нужно просматривать логи Gateway (шлюза) удалённо (без SSH)
  - Вам нужны строки логов в формате JSON для инструментов
title: "логи"
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
