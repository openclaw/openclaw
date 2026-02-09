---
summary: "Справка CLI для `openclaw update` (относительно безопасное обновление исходников + автоперезапуск Gateway (шлюз))"
read_when:
  - Вам нужно безопасно обновить checkout исходников
  - Вам нужно понять поведение сокращения `--update`
title: "update"
---

# `openclaw update`

Безопасно обновляет OpenClaw и позволяет переключаться между каналами stable/beta/dev.

Если установка выполнена через **npm/pnpm** (глобальная установка, без git-метаданных), обновления происходят через поток менеджера пакетов, описанный в разделе [Updating](/install/updating).

## Использование

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Параметры

- `--no-restart`: пропустить перезапуск сервиса Gateway (шлюз) после успешного обновления.
- `--channel <stable|beta|dev>`: задать канал обновлений (git + npm; сохраняется в конфиге).
- `--tag <dist-tag|version>`: переопределить npm dist-tag или версию только для этого обновления.
- `--json`: вывести машиночитаемый JSON `UpdateRunResult`.
- `--timeout <seconds>`: тайм-аут на шаг (по умолчанию 1200 с).

Примечание: понижение версии требует подтверждения, поскольку более старые версии могут нарушить конфигурацию.

## `update status`

Показывает активный канал обновлений + git‑тег/ветку/SHA (для checkout исходников), а также доступность обновлений.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Параметры:

- `--json`: вывести машиночитаемый JSON состояния.
- `--timeout <seconds>`: тайм-аут для проверок (по умолчанию 3 с).

## `update wizard`

Интерактивный процесс выбора канала обновлений и подтверждения перезапуска Gateway (шлюз)
после обновления (по умолчанию перезапуск выполняется). Если выбран `dev` без git‑checkout,
будет предложено создать его.

## Что делает

При явном переключении каналов (`--channel ...`) OpenClaw также поддерживает
согласованность способа установки:

- `dev` → обеспечивает наличие git‑checkout (по умолчанию: `~/openclaw`, можно переопределить с помощью `OPENCLAW_GIT_DIR`),
  обновляет его и устанавливает глобальный CLI из этого checkout.
- `stable`/`beta` → устанавливает из npm с использованием соответствующего dist‑tag.

## Процесс git‑checkout

Каналы:

- `stable`: checkout последнего не‑бета тега, затем сборка + doctor.
- `beta`: checkout последнего тега `-beta`, затем сборка + doctor.
- `dev`: checkout `main`, затем fetch + rebase.

Высокий уровень:

1. Требуется чистое рабочее дерево (без незафиксированных изменений).
2. Переключается на выбранный канал (тег или ветку).
3. Получает обновления из upstream (только dev).
4. Только dev: предварительная проверка lint + сборка TypeScript во временном worktree; если текущая версия не проходит, откатывается назад максимум на 10 коммитов, чтобы найти самую новую успешную сборку.
5. Выполняет rebase на выбранный коммит (только dev).
6. Устанавливает зависимости (предпочтительно pnpm; резервно — npm).
7. Выполняет сборку и сборку Control UI.
8. Запускает `openclaw doctor` как финальную «безопасную проверку обновления».
9. Синхронизирует плагины с активным каналом (dev использует расширения из комплекта; stable/beta — npm) и обновляет плагины, установленные через npm.

## Сокращение `--update`

`openclaw --update` переписывается в `openclaw update` (удобно для оболочек и скриптов запуска).

## См. также

- `openclaw doctor` (предлагает сначала запустить обновление для git‑checkout)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
