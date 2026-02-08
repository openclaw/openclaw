---
summary: "Справочник CLI для `openclaw system` (системные события, сигналы keepalive, присутствие)"
read_when:
  - Вы хотите поставить системное событие в очередь без создания cron-задачи
  - Вам нужно включить или отключить сигналы keepalive
  - Вы хотите просмотреть записи системного присутствия
title: "system"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:19Z
---

# `openclaw system`

Системные вспомогательные команды для Gateway (шлюз): постановка системных событий в очередь, управление сигналами keepalive
и просмотр присутствия.

## Часто используемые команды

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Поставить системное событие в очередь в **основном** сеансе. Следующий сигнал keepalive внедрит
его как строку `System:` в приглашение. Используйте `--mode now`, чтобы запустить сигнал keepalive
немедленно; `next-heartbeat` ожидает следующего запланированного тика.

Флаги:

- `--text <text>`: обязательный текст системного события.
- `--mode <mode>`: `now` или `next-heartbeat` (по умолчанию).
- `--json`: машиночитаемый вывод.

## `system heartbeat last|enable|disable`

Управление сигналами keepalive:

- `last`: показать последнее событие сигнала keepalive.
- `enable`: включить сигналы keepalive обратно (используйте, если они были отключены).
- `disable`: приостановить сигналы keepalive.

Флаги:

- `--json`: машиночитаемый вывод.

## `system presence`

Вывести список текущих записей системного присутствия, известных Gateway (шлюз) (узлы,
экземпляры и аналогичные строки состояния).

Флаги:

- `--json`: машиночитаемый вывод.

## Примечания

- Требуется запущенный Gateway (шлюз), доступный согласно текущему конфигу (локально или удалённо).
- Системные события являются эфемерными и не сохраняются между перезапусками.
