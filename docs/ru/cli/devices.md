---
summary: "Справка CLI для `openclaw devices` (сопряжение устройств + ротация/отзыв токенов)"
read_when:
  - Вы утверждаете запросы на сопряжение устройств
  - Вам нужно выполнить ротацию или отзыв токенов устройств
title: "устройства"
---

# `openclaw devices`

Управление запросами на сопряжение устройств и токенами с областью действия устройства.

## Команды

### `openclaw devices list`

Показать список ожидающих запросов на сопряжение и уже сопряжённых устройств.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Утвердить ожидающий запрос на сопряжение устройства.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Отклонить ожидающий запрос на сопряжение устройства.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Выполнить ротацию токена устройства для конкретной роли (при необходимости обновив области доступа).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Отозвать токен устройства для конкретной роли.

```
openclaw devices revoke --device <deviceId> --role node
```

## Общие параметры

- `--url <url>`: URL WebSocket Gateway (шлюз) (по умолчанию — `gateway.remote.url`, если настроено).
- `--token <token>`: токен Gateway (шлюз) (если требуется).
- `--password <password>`: пароль Gateway (шлюз) (аутентификация по паролю).
- `--timeout <ms>`: тайм-аут RPC.
- `--json`: вывод в формате JSON (рекомендуется для скриптов).

Примечание: при указании `--url` CLI не выполняет откат к конфигу или переменным окружения для учётных данных.
Явно передайте `--token` или `--password`. Отсутствие явно заданных учётных данных является ошибкой.

## Примечания

- Ротация токена возвращает новый токен (чувствительные данные). Обращайтесь с ним как с секретом.
- Эти команды требуют область доступа `operator.pairing` (или `operator.admin`).
