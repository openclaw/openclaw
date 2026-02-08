---
summary: "Справочник CLI для `openclaw plugins` (list, install, enable/disable, doctor)"
read_when:
  - Вам нужно установить или управлять внутрипроцессными плагинами Gateway (шлюз)
  - Вам нужно отладить ошибки загрузки плагинов
title: "плагины"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:21Z
---

# `openclaw plugins`

Управление плагинами/расширениями Gateway (шлюз) (загружаются внутрипроцессно).

Связанное:

- Система плагинов: [Plugins](/tools/plugin)
- Манифест плагина и схема: [Plugin manifest](/plugins/manifest)
- Усиление безопасности: [Security](/gateway/security)

## Команды

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Плагины, поставляемые в комплекте, входят в OpenClaw, но изначально отключены. Используйте `plugins enable`, чтобы
активировать их.

Все плагины должны поставляться с файлом `openclaw.plugin.json` с встроенной JSON Schema
(`configSchema`, даже если она пустая). Отсутствующие или некорректные манифесты либо схемы
препятствуют загрузке плагина и приводят к ошибке валидации конфига.

### Установка

```bash
openclaw plugins install <path-or-spec>
```

Примечание по безопасности: относитесь к установке плагинов как к запуску кода. Предпочитайте закреплённые версии.

Поддерживаемые архивы: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Используйте `--link`, чтобы избежать копирования локального каталога (добавляет в `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Обновление

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Обновления применяются только к плагинам, установленным из npm (отслеживаются в `plugins.installs`).
