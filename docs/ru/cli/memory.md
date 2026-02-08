---
summary: "Справочник CLI для `openclaw memory` (status/index/search)"
read_when:
  - Вам нужно индексировать или искать семантическую память
  - Вы отлаживаете доступность памяти или индексацию
title: "memory"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:13Z
---

# `openclaw memory`

Управление индексацией и поиском семантической памяти.
Предоставляется активным плагином памяти (по умолчанию: `memory-core`; установите `plugins.slots.memory = "none"`, чтобы отключить).

Связанное:

- Концепция памяти: [Memory](/concepts/memory)
- Плагины: [Plugins](/tools/plugin)

## Примеры

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Параметры

Общие:

- `--agent <id>`: ограничить область одним агентом (по умолчанию: все настроенные агенты).
- `--verbose`: выводить подробные логи во время проверок и индексации.

Примечания:

- `memory status --deep` проверяет доступность векторов и эмбеддингов.
- `memory status --deep --index` выполняет переиндексацию, если хранилище помечено как «грязное».
- `memory index --verbose` выводит детали по каждому этапу (провайдер, модель, источники, активность батчей).
- `memory status` включает любые дополнительные пути, настроенные через `memorySearch.extraPaths`.
