---
summary: "Конфигурация и настройка чат-бота Twitch"
read_when:
  - Настройка интеграции чата Twitch для OpenClaw
title: "Twitch"
---

# Twitch (плагин)

Поддержка чата Twitch через подключение по IRC. OpenClaw подключается как пользователь Twitch (учётная запись бота) для получения и отправки сообщений в каналах.

## Требуется плагин

Twitch поставляется как плагин и не входит в основной дистрибутив.

Установка через CLI (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

Локальный checkout (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/twitch
```

Подробности: [Plugins](/tools/plugin)

## Быстрая настройка (для начинающих)

1. Создайте отдельную учётную запись Twitch для бота (или используйте существующую).
2. Сгенерируйте учётные данные: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Выберите **Bot Token**
   - Убедитесь, что выбраны области доступа `chat:read` и `chat:write`
   - Скопируйте **Client ID** и **Access Token**
3. Найдите свой Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Настройте токен:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (только для учётной записи по умолчанию)
   - Или конфиг: `channels.twitch.accessToken`
   - Если заданы оба варианта, приоритет имеет конфиг (env используется только как запасной вариант для учётной записи по умолчанию).
5. Запустите Gateway (шлюз).

**⚠️ Важно:** Добавьте контроль доступа (`allowFrom` или `allowedRoles`), чтобы предотвратить запуск бота неавторизованными пользователями. Значение `requireMention` по умолчанию — `true`.

Минимальный конфиг:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Что это такое

- Канал Twitch, принадлежащий Gateway (шлюзу).
- Детерминированная маршрутизация: ответы всегда возвращаются в Twitch.
- Каждая учётная запись сопоставляется с изолированным ключом сеанса `agent:<agentId>:twitch:<accountName>`.
- `username` — это учётная запись бота (кто аутентифицируется), `channel` — это чат, к которому нужно подключиться.

## Настройка (подробно)

### Генерация учётных данных

Используйте [Twitch Token Generator](https://twitchtokengenerator.com/):

- Выберите **Bot Token**
- Убедитесь, что выбраны области доступа `chat:read` и `chat:write`
- Скопируйте **Client ID** и **Access Token**

Ручная регистрация приложения не требуется. Токены истекают через несколько часов.

### Настройка бота

**Переменная окружения (только для учётной записи по умолчанию):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Или конфиг:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Если заданы и env, и конфиг, приоритет имеет конфиг.

### Контроль доступа (рекомендуется)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Предпочтительно использовать `allowFrom` для жёсткого allowlist. Используйте `allowedRoles`, если нужен доступ на основе ролей.

**Доступные роли:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Почему user ID?** Имена пользователей могут меняться, что допускает подмену. User ID постоянны.

Найдите свой Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Преобразование имени пользователя Twitch в ID)

## Обновление токена (необязательно)

Токены из [Twitch Token Generator](https://twitchtokengenerator.com/) не могут обновляться автоматически — при истечении срока действия их нужно пересоздавать.

Для автоматического обновления токена создайте собственное приложение Twitch в [Twitch Developer Console](https://dev.twitch.tv/console) и добавьте в конфиг:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Бот автоматически обновляет токены до истечения срока действия и пишет события обновления в логи.

## Поддержка нескольких учётных записей

Используйте `channels.twitch.accounts` с токенами для каждой учётной записи. См. [`gateway/configuration`](/gateway/configuration) для общего шаблона.

Пример (одна учётная запись бота в двух каналах):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Примечание:** Для каждой учётной записи требуется собственный токен (один токен на канал).

## Контроль доступа

### Ограничения на основе ролей

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Allowlist по User ID (наиболее безопасно)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Доступ на основе ролей (альтернатива)

`allowFrom` — это жёсткий allowlist. Если он задан, разрешены только указанные user ID.
Если нужен доступ на основе ролей, оставьте `allowFrom` неустановленным и настройте `allowedRoles`:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Отключение требования @mention

По умолчанию `requireMention` имеет значение `true`. Чтобы отключить и отвечать на все сообщения:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Устранение неполадок

Сначала выполните диагностические команды:

```bash
openclaw doctor
openclaw channels status --probe
```

### Бот не отвечает на сообщения

**Проверьте контроль доступа:** Убедитесь, что ваш user ID находится в `allowFrom`, либо временно удалите
`allowFrom` и установите `allowedRoles: ["all"]` для тестирования.

**Проверьте, что бот находится в канале:** Бот должен присоединиться к каналу, указанному в `channel`.

### Замечания по токенам

**«Failed to connect» или ошибки аутентификации:**

- Убедитесь, что `accessToken` — это значение OAuth access token (обычно начинается с префикса `oauth:`)
- Проверьте, что у токена есть области доступа `chat:read` и `chat:write`
- Если используется обновление токена, убедитесь, что заданы `clientSecret` и `refreshToken`

### Обновление токена не работает

**Проверьте логи на наличие событий обновления:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Если вы видите «token refresh disabled (no refresh token)»:

- Убедитесь, что указан `clientSecret`
- Убедитесь, что указан `refreshToken`

## Конфиг

**Конфиг учётной записи:**

- `username` — имя пользователя бота
- `accessToken` — OAuth access token с областями `chat:read` и `chat:write`
- `clientId` — Twitch Client ID (из Token Generator или вашего приложения)
- `channel` — канал для подключения (обязательно)
- `enabled` — включить эту учётную запись (по умолчанию: `true`)
- `clientSecret` — необязательно: для автоматического обновления токена
- `refreshToken` — необязательно: для автоматического обновления токена
- `expiresIn` — срок действия токена в секундах
- `obtainmentTimestamp` — временная метка получения токена
- `allowFrom` — allowlist user ID
- `allowedRoles` — контроль доступа на основе ролей (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` — требовать @mention (по умолчанию: `true`)

**Параметры провайдера:**

- `channels.twitch.enabled` — включить/отключить запуск канала
- `channels.twitch.username` — имя пользователя бота (упрощённая конфигурация для одной учётной записи)
- `channels.twitch.accessToken` — OAuth access token (упрощённая конфигурация для одной учётной записи)
- `channels.twitch.clientId` — Twitch Client ID (упрощённая конфигурация для одной учётной записи)
- `channels.twitch.channel` — канал для подключения (упрощённая конфигурация для одной учётной записи)
- `channels.twitch.accounts.<accountName>` — конфигурация для нескольких учётных записей (все поля учётной записи выше)

Полный пример:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Действия инструмента

Агент может вызывать `twitch` с действием:

- `send` — отправить сообщение в канал

Пример:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Безопасность и эксплуатация

- **Относитесь к токенам как к паролям** — никогда не коммитьте токены в git
- **Используйте автоматическое обновление токенов** для долгоживущих ботов
- **Используйте allowlist по user ID** вместо имён пользователей для контроля доступа
- **Отслеживайте логи** на предмет событий обновления токенов и состояния подключения
- **Минимизируйте области доступа токенов** — запрашивайте только `chat:read` и `chat:write`
- **Если возникли проблемы**: перезапустите Gateway (шлюз) после подтверждения, что ни один другой процесс не владеет сеансом

## Ограничения

- **500 символов** на сообщение (автоматическое разбиение по границам слов)
- Markdown удаляется перед разбиением
- Ограничение скорости отсутствует (используются встроенные лимиты Twitch)
