---
summary: "Устранение неполадок планирования и доставки cron и heartbeat"
read_when:
  - Cron не запустился
  - Cron запустился, но сообщение не было доставлено
  - Heartbeat кажется молчащим или пропущенным
title: "Устранение неполадок автоматизации"
---

# Устранение неполадок автоматизации

Используйте эту страницу для проблем с планировщиком и доставкой (`cron` + `heartbeat`).

## Командная лестница

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Затем запустите проверки автоматизации:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron не срабатывает

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Корректный вывод выглядит так:

- `cron status` сообщает, что включено, и указывает будущий `nextWakeAtMs`.
- Задание включено и имеет корректное расписание/часовой пояс.
- `cron runs` показывает `ok` или явную причину пропуска.

Общие подписи:

- `cron: scheduler disabled; jobs will not run automatically` → cron отключён в конфиге/переменных окружения.
- `cron: timer tick failed` → сбой тика планировщика; проверьте окружающий стек/контекст логов.
- `reason: not-due` в выводе запуска → ручной запуск вызван без `--force`, и задание ещё не должно выполняться.

## Cron сработал, но доставки нет

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Корректный вывод выглядит так:

- Статус запуска — `ok`.
- Для изолированных заданий задан режим доставки/цель.
- Проба канала сообщает, что целевой канал подключён.

Общие подписи:

- Запуск успешен, но режим доставки — `none` → внешнее сообщение не ожидается.
- Цель доставки отсутствует/некорректна (`channel`/`to`) → запуск может завершиться успешно внутренне, но исходящая отправка пропускается.
- Ошибки аутентификации канала (`unauthorized`, `missing_scope`, `Forbidden`) → доставка заблокирована из‑за учётных данных/прав канала.

## Heartbeat подавлен или пропущен

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Корректный вывод выглядит так:

- Heartbeat включён с ненулевым интервалом.
- Результат последнего heartbeat — `ran` (или причина пропуска понятна).

Общие подписи:

- `heartbeat skipped` с `reason=quiet-hours` → вне `activeHours`.
- `requests-in-flight` → основной поток занят; heartbeat отложен.
- `empty-heartbeat-file` → существует `HEARTBEAT.md`, но нет полезного содержимого.
- `alerts-disabled` → настройки видимости подавляют исходящие сообщения heartbeat.

## Подводные камни timezone и activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Быстрые правила:

- `Config path not found: agents.defaults.userTimezone` означает, что ключ не задан; heartbeat откатывается к часовому поясу хоста (или `activeHours.timezone`, если задано).
- Cron без `--tz` использует часовой пояс хоста Gateway (шлюза).
- Heartbeat `activeHours` использует настроенное разрешение часового пояса (`user`, `local` или явный IANA tz).
- ISO‑временные метки без часового пояса трактуются как UTC для cron‑расписаний `at`.

Общие подписи:

- Задания выполняются не в то «настенное» время после изменения часового пояса хоста.
- Heartbeat всегда пропускается днём, потому что `activeHours.timezone` задан неверно.

Связанное:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
