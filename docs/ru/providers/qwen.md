---
summary: "Используйте OAuth Qwen (бесплатный уровень) в OpenClaw"
read_when:
  - Вы хотите использовать Qwen с OpenClaw
  - Вам нужен доступ к Qwen Coder по OAuth на бесплатном уровне
title: "Qwen"
---

# Qwen

Qwen предоставляет поток OAuth бесплатного уровня для моделей Qwen Coder и Qwen Vision
(2 000 запросов в день, с учётом лимитов Qwen).

## Включить плагин

```bash
openclaw plugins enable qwen-portal-auth
```

Перезапустите Gateway (шлюз) после включения.

## Аутентификация

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Это запускает поток OAuth Qwen с device-code и записывает запись провайдера в ваш
`models.json` (а также псевдоним `qwen` для быстрого переключения).

## Идентификаторы моделей

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Переключение моделей:

```bash
openclaw models set qwen-portal/coder-model
```

## Повторное использование входа Qwen Code CLI

Если вы уже входили через Qwen Code CLI, OpenClaw синхронизирует учётные данные
из `~/.qwen/oauth_creds.json` при загрузке хранилища аутентификации. Вам всё равно нужна запись
`models.providers.qwen-portal` (используйте команду входа выше, чтобы создать её).

## Примечания

- Токены обновляются автоматически; повторно выполните команду входа, если обновление не удалось или доступ был отозван.
- Базовый URL по умолчанию: `https://portal.qwen.ai/v1` (переопределите с помощью
  `models.providers.qwen-portal.baseUrl`, если Qwen предоставит другой endpoint).
- [Model providers](/concepts/model-providers) для правил, общих для провайдеров.
