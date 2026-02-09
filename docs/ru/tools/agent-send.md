---
summary: "Прямые запуски CLI `openclaw agent` (с необязательной доставкой)"
read_when:
  - При добавлении или изменении точки входа CLI агента
title: "Отправка агента"
---

# `openclaw agent` (прямые запуски агента)

`openclaw agent` выполняет один ход агента без необходимости входящего сообщения чата.
По умолчанию выполнение идёт **через Gateway (шлюз)**; добавьте `--local`, чтобы принудительно использовать встроенный
рантайм на текущей машине.

## Поведение

- Обязательно: `--message <text>`
- Выбор сеанса:
  - `--to <dest>` выводит ключ сеанса (цели групп/каналов сохраняют изоляцию; прямые чаты сводятся к `main`), **или**
  - `--session-id <id>` повторно использует существующий сеанс по id, **или**
  - `--agent <id>` нацеливается напрямую на настроенного агента (использует ключ сеанса этого агента `main`)
- Запускает тот же встроенный рантайм агента, что и обычные входящие ответы.
- Флаги thinking/verbose сохраняются в хранилище сеансов.
- Вывод:
  - по умолчанию: печатает текст ответа (плюс строки `MEDIA:<url>`)
  - `--json`: печатает структурированный полезный нагруз + метаданные
- Необязательная доставка обратно в канал с помощью `--deliver` + `--channel` (форматы целей соответствуют `openclaw message --target`).
- Используйте `--reply-channel`/`--reply-to`/`--reply-account`, чтобы переопределить доставку без изменения сеанса.

Если Gateway (шлюз) недоступен, CLI **выполняет откат** к встроенному локальному запуску.

## Примеры

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Флаги

- `--local`: запуск локально (требуются ключи API провайдера модели в вашей оболочке)
- `--deliver`: отправить ответ в выбранный канал
- `--channel`: канал доставки (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, по умолчанию: `whatsapp`)
- `--reply-to`: переопределение цели доставки
- `--reply-channel`: переопределение канала доставки
- `--reply-account`: переопределение id учётной записи доставки
- `--thinking <off|minimal|low|medium|high|xhigh>`: сохранять уровень thinking (только модели GPT-5.2 + Codex)
- `--verbose <on|full|off>`: сохранять уровень verbose
- `--timeout <seconds>`: переопределение тайм-аута агента
- `--json`: вывод структурированного JSON
