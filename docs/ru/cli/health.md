---
summary: "Справочник CLI для `openclaw health` (эндпоинт здоровья Gateway (шлюз) через RPC)"
read_when:
  - Вам нужно быстро проверить состояние работающего Gateway (шлюз)
title: "health"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:13Z
---

# `openclaw health`

Получить состояние здоровья работающего Gateway (шлюз).

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Примечания:

- `--verbose` выполняет живые пробы и выводит тайминги по каждому аккаунту, когда настроено несколько аккаунтов.
- Вывод включает хранилища сеансов по каждому агенту, когда настроено несколько агентов.
