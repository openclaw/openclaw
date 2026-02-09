---
summary: "Поддержка личного аккаунта Zalo через zca-cli (вход по QR), возможности и конфигурация"
read_when:
  - Настройка Zalo Personal для OpenClaw
  - Отладка входа или потока сообщений Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (неофициально)

Статус: экспериментально. Эта интеграция автоматизирует **личный аккаунт Zalo** через `zca-cli`.

> **Предупреждение:** Это неофициальная интеграция и она может привести к приостановке или бану аккаунта. Используйте на свой риск.

## Требуется плагин

Zalo Personal поставляется как плагин и не входит в состав базовой установки.

- Установка через CLI: `openclaw plugins install @openclaw/zalouser`
- Или из исходного репозитория: `openclaw plugins install ./extensions/zalouser`
- Подробности: [Plugins](/tools/plugin)

## Предварительное требование: zca-cli

На машине Gateway должен быть доступен бинарный файл `zca` в `PATH`.

- Проверка: `zca --version`
- Если отсутствует, установите zca-cli (см. `extensions/zalouser/README.md` или документацию upstream zca-cli).

## Быстрая настройка (для начинающих)

1. Установите плагин (см. выше).
2. Войдите (QR, на машине Gateway):
   - `openclaw channels login --channel zalouser`
   - Отсканируйте QR-код в терминале с помощью мобильного приложения Zalo.
3. Включите канал:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Перезапустите Gateway (или завершите онбординг).
5. Доступ к личным сообщениям по умолчанию основан на сопряжении; подтвердите код сопряжения при первом контакте.

## Что это такое

- Использует `zca listen` для получения входящих сообщений.
- Использует `zca msg ...` для отправки ответов (текст/медиа/ссылки).
- Предназначено для сценариев «личного аккаунта», где API Zalo Bot недоступен.

## Именование

Идентификатор канала — `zalouser`, чтобы явно указать, что автоматизируется **личный пользовательский аккаунт Zalo** (неофициально). Мы сохраняем `zalo` зарезервированным для возможной будущей официальной интеграции с API Zalo.

## Поиск ID (каталог)

Используйте CLI каталога, чтобы обнаруживать контакты/группы и их ID:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Ограничения

- Исходящий текст разбивается на фрагменты примерно по 2000 символов (ограничения клиента Zalo).
- Потоковая передача по умолчанию заблокирована.

## Контроль доступа (личные сообщения)

`channels.zalouser.dmPolicy` поддерживает: `pairing | allowlist | open | disabled` (по умолчанию: `pairing`).
`channels.zalouser.allowFrom` принимает ID пользователей или имена. Мастер настраивания сопоставляет имена с ID через `zca friend find`, если доступно.

Подтверждение через:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Доступ к группам (необязательно)

- По умолчанию: `channels.zalouser.groupPolicy = "open"` (группы разрешены). Используйте `channels.defaults.groupPolicy`, чтобы переопределить значение по умолчанию, если параметр не задан.
- Ограничение по списку разрешённых:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (ключи — ID групп или имена)
- Блокировать все группы: `channels.zalouser.groupPolicy = "disabled"`.
- Мастер конфигурации может запросить списки разрешённых групп.
- При запуске OpenClaw сопоставляет имена групп/пользователей в списках разрешённых с ID и журналирует соответствие; неразрешённые элементы сохраняются как введены.

Пример:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Мультиаккаунт

Аккаунты сопоставляются с профилями zca. Пример:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Устранение неполадок

**`zca` не найден:**

- Установите zca-cli и убедитесь, что он доступен в `PATH` для процесса Gateway.

**Вход не сохраняется:**

- `openclaw channels status --probe`
- Повторный вход: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
