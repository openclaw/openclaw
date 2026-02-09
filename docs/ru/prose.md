---
summary: "OpenProse: рабочие процессы .prose, slash-команды и состояние в OpenClaw"
read_when:
  - Вы хотите запускать или писать рабочие процессы .prose
  - Вы хотите включить плагин OpenProse
  - Вам нужно понять хранение состояния
title: "OpenProse"
---

# OpenProse

OpenProse — это переносимый, ориентированный на Markdown формат рабочих процессов для оркестрации AI-сеансов. В OpenClaw он поставляется как плагин, который устанавливает пакет Skills OpenProse, а также slash-команду `/prose`. Программы хранятся в файлах `.prose` и могут порождать несколько подагентов с явным управлением потоком выполнения.

Официальный сайт: [https://www.prose.md](https://www.prose.md)

## Что он умеет

- Многоагентное исследование и синтез с явным параллелизмом.
- Повторяемые, безопасные с точки зрения подтверждений рабочие процессы (code review, триаж инцидентов, контент‑конвейеры).
- Переиспользуемые программы `.prose`, которые можно запускать в поддерживаемых средах выполнения агентов.

## Установка и включение

Плагины, поставляемые в комплекте, по умолчанию отключены. Включите OpenProse:

```bash
openclaw plugins enable open-prose
```

После включения плагина перезапустите Gateway (шлюз).

Dev/локальная сборка: `openclaw plugins install ./extensions/open-prose`

Связанная документация: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash-команда

OpenProse регистрирует `/prose` как пользовательскую команду Skills. Она маршрутизирует выполнение к инструкциям VM OpenProse и использует инструменты OpenClaw «под капотом».

Часто используемые команды:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Пример: простой файл `.prose`

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Расположение файлов

OpenProse хранит состояние в каталоге `.prose/` в вашем рабочем пространстве:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Постоянные агенты на уровне пользователя находятся здесь:

```
~/.prose/agents/
```

## Режимы состояния

OpenProse поддерживает несколько бэкендов состояния:

- **filesystem** (по умолчанию): `.prose/runs/...`
- **in-context**: временный, для небольших программ
- **sqlite** (экспериментально): требуется бинарник `sqlite3`
- **postgres** (экспериментально): требуется `psql` и строка подключения

Примечания:

- sqlite/postgres — опциональные и экспериментальные.
- Учетные данные postgres попадают в логи подагентов; используйте выделенную БД с минимально необходимыми правами.

## Удаленные программы

`/prose run <handle/slug>` разрешается в `https://p.prose.md/<handle>/<slug>`.
Прямые URL загружаются «как есть». Для этого используется инструмент `web_fetch` (или `exec` для POST).

## Сопоставление с рантаймом OpenClaw

Программы OpenProse сопоставляются с примитивами OpenClaw:

| Концепция OpenProse       | Инструмент OpenClaw |
| ------------------------- | ------------------- |
| Запуск сеанса / Task tool | `sessions_spawn`    |
| Чтение/запись файлов      | `read` / `write`    |
| Веб-выборка               | `web_fetch`         |

Если ваш allowlist инструментов блокирует эти инструменты, программы OpenProse не будут выполняться. См. [Skills config](/tools/skills-config).

## Безопасность и подтверждения

Относитесь к файлам `.prose` как к коду. Проверяйте их перед запуском. Используйте allowlist инструментов OpenClaw и шлюзы подтверждений для контроля побочных эффектов.

Для детерминированных рабочих процессов с подтверждениями сравните с [Lobster](/tools/lobster).
