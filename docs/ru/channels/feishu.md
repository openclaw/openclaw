---
summary: "Обзор бота Feishu, возможности и конфигурация"
read_when:
  - Вы хотите подключить бота Feishu/Lark
  - Вы настраиваете канал Feishu
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:29Z
---

# Бот Feishu

Feishu (Lark) — это корпоративная платформа командного чата, используемая компаниями для обмена сообщениями и совместной работы. Этот плагин подключает OpenClaw к боту Feishu/Lark с использованием подписки на события WebSocket платформы, благодаря чему сообщения могут приниматься без публикации публичного URL вебхука.

---

## Требуется плагин

Установите плагин Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Локальная установка (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Быстрый старт

Существует два способа добавить канал Feishu:

### Метод 1: мастер онбординга (рекомендуется)

Если вы только что установили OpenClaw, запустите мастер:

```bash
openclaw onboard
```

Мастер проведёт вас через следующие шаги:

1. Создание приложения Feishu и сбор учётных данных
2. Настройка учётных данных приложения в OpenClaw
3. Запуск Gateway (шлюза)

✅ **После настройки** проверьте статус Gateway (шлюза):

- `openclaw gateway status`
- `openclaw logs --follow`

### Метод 2: настройка через CLI

Если вы уже завершили начальную установку, добавьте канал через CLI:

```bash
openclaw channels add
```

Выберите **Feishu**, затем введите App ID и App Secret.

✅ **После настройки** управляйте Gateway (шлюзом):

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Шаг 1: Создание приложения Feishu

### 1. Откройте Feishu Open Platform

Перейдите на [Feishu Open Platform](https://open.feishu.cn/app) и войдите в систему.

Арендаторы Lark (глобальная версия) должны использовать [https://open.larksuite.com/app](https://open.larksuite.com/app) и установить `domain: "lark"` в конфигурации Feishu.

### 2. Создайте приложение

1. Нажмите **Create enterprise app**
2. Заполните название и описание приложения
3. Выберите иконку приложения

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Скопируйте учётные данные

В разделе **Credentials & Basic Info** скопируйте:

- **App ID** (формат: `cli_xxx`)
- **App Secret**

❗ **Важно:** храните App Secret в тайне.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Настройте разрешения

В разделе **Permissions** нажмите **Batch import** и вставьте:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Включите возможность бота

В **App Capability** > **Bot**:

1. Включите возможность бота
2. Задайте имя бота

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Настройте подписку на события

⚠️ **Важно:** перед настройкой подписки на события убедитесь, что:

1. Вы уже выполнили `openclaw channels add` для Feishu
2. Gateway (шлюз) запущен (`openclaw gateway status`)

В разделе **Event Subscription**:

1. Выберите **Use long connection to receive events** (WebSocket)
2. Добавьте событие: `im.message.receive_v1`

⚠️ Если Gateway (шлюз) не запущен, настройка долгого соединения может не сохраниться.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Опубликуйте приложение

1. Создайте версию в **Version Management & Release**
2. Отправьте на проверку и опубликуйте
3. Дождитесь одобрения администратора (корпоративные приложения обычно одобряются автоматически)

---

## Шаг 2: Настройка OpenClaw

### Настройка с помощью мастера (рекомендуется)

```bash
openclaw channels add
```

Выберите **Feishu** и вставьте ваши App ID и App Secret.

### Настройка через конфигурационный файл

Отредактируйте `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Настройка через переменные окружения

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Домен Lark (глобальная версия)

Если ваш арендатор использует Lark (международная версия), установите домен `lark` (или полную строку домена). Это можно задать в `channels.feishu.domain` или для каждой учётной записи отдельно (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Шаг 3: Запуск и тестирование

### 1. Запустите Gateway (шлюз)

```bash
openclaw gateway
```

### 2. Отправьте тестовое сообщение

В Feishu найдите вашего бота и отправьте сообщение.

### 3. Подтвердите сопряжение

По умолчанию бот отвечает кодом сопряжения. Подтвердите его:

```bash
openclaw pairing approve feishu <CODE>
```

После подтверждения вы можете общаться в обычном режиме.

---

## Обзор

- **Канал бота Feishu**: бот Feishu, управляемый Gateway (шлюзом)
- **Детерминированная маршрутизация**: ответы всегда возвращаются в Feishu
- **Изоляция сеансов**: личные сообщения используют основной сеанс; группы изолированы
- **WebSocket‑подключение**: длительное соединение через SDK Feishu, публичный URL не требуется

---

## Контроль доступа

### Личные сообщения

- **По умолчанию**: `dmPolicy: "pairing"` (неизвестные пользователи получают код сопряжения)
- **Подтверждение сопряжения**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Режим списка разрешённых**: установите `channels.feishu.allowFrom` со списком разрешённых Open ID

### Групповые чаты

**1. Политика групп** (`channels.feishu.groupPolicy`):

- `"open"` = разрешить всем в группах (по умолчанию)
- `"allowlist"` = разрешить только `groupAllowFrom`
- `"disabled"` = отключить групповые сообщения

**2. Требование упоминания** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = требовать @упоминание (по умолчанию)
- `false` = отвечать без упоминаний

---

## Примеры конфигурации групп

### Разрешить все группы, требовать @упоминание (по умолчанию)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Разрешить все группы, без требования @упоминания

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Разрешить только определённых пользователей в группах

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Получение ID групп и пользователей

### ID групп (chat_id)

ID групп выглядят как `oc_xxx`.

**Метод 1 (рекомендуется)**

1. Запустите Gateway (шлюз) и @упомяните бота в группе
2. Выполните `openclaw logs --follow` и найдите `chat_id`

**Метод 2**

Используйте отладчик API Feishu для получения списка групповых чатов.

### ID пользователей (open_id)

ID пользователей выглядят как `ou_xxx`.

**Метод 1 (рекомендуется)**

1. Запустите Gateway (шлюз) и отправьте боту личное сообщение
2. Выполните `openclaw logs --follow` и найдите `open_id`

**Метод 2**

Проверьте запросы на сопряжение для получения Open ID пользователей:

```bash
openclaw pairing list feishu
```

---

## Часто используемые команды

| Команда   | Описание                |
| --------- | ----------------------- |
| `/status` | Показать статус бота    |
| `/reset`  | Сбросить сеанс          |
| `/model`  | Показать/сменить модель |

> Примечание: Feishu пока не поддерживает нативные меню команд, поэтому команды необходимо отправлять текстом.

## Команды управления Gateway (шлюзом)

| Команда                    | Описание                            |
| -------------------------- | ----------------------------------- |
| `openclaw gateway status`  | Показать статус Gateway (шлюза)     |
| `openclaw gateway install` | Установить/запустить сервис Gateway |
| `openclaw gateway stop`    | Остановить сервис Gateway           |
| `openclaw gateway restart` | Перезапустить сервис Gateway        |
| `openclaw logs --follow`   | Просмотр логов Gateway              |

---

## Устранение неполадок

### Бот не отвечает в групповых чатах

1. Убедитесь, что бот добавлен в группу
2. Убедитесь, что вы @упоминаете бота (поведение по умолчанию)
3. Проверьте, что `groupPolicy` не установлен в `"disabled"`
4. Проверьте логи: `openclaw logs --follow`

### Бот не получает сообщения

1. Убедитесь, что приложение опубликовано и одобрено
2. Убедитесь, что подписка на события включает `im.message.receive_v1`
3. Убедитесь, что включено **долгое соединение**
4. Убедитесь, что разрешения приложения настроены полностью
5. Убедитесь, что Gateway (шлюз) запущен: `openclaw gateway status`
6. Проверьте логи: `openclaw logs --follow`

### Утечка App Secret

1. Сбросьте App Secret в Feishu Open Platform
2. Обновите App Secret в вашей конфигурации
3. Перезапустите Gateway (шлюз)

### Ошибки отправки сообщений

1. Убедитесь, что у приложения есть разрешение `im:message:send_as_bot`
2. Убедитесь, что приложение опубликовано
3. Проверьте логи для получения подробных ошибок

---

## Расширенная конфигурация

### Несколько учётных записей

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Ограничения сообщений

- `textChunkLimit`: размер чанка исходящего текста (по умолчанию: 2000 символов)
- `mediaMaxMb`: лимит загрузки/скачивания медиа (по умолчанию: 30 МБ)

### Потоковая передача

Feishu поддерживает потоковые ответы через интерактивные карточки. При включении бот обновляет карточку по мере генерации текста.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Установите `streaming: false`, чтобы дождаться полного ответа перед отправкой.

### Маршрутизация нескольких агентов

Используйте `bindings` для маршрутизации личных сообщений Feishu или групп к разным агентам.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Поля маршрутизации:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` или `"group"`
- `match.peer.id`: Open ID пользователя (`ou_xxx`) или ID группы (`oc_xxx`)

См. [Получение ID групп и пользователей](#get-groupuser-ids) для советов по поиску.

---

## Справочник конфигурации

Полная конфигурация: [Конфигурация Gateway](/gateway/configuration)

Ключевые параметры:

| Параметр                                          | Описание                                      | По умолчанию |
| ------------------------------------------------- | --------------------------------------------- | ------------ |
| `channels.feishu.enabled`                         | Включить/отключить канал                      | `true`       |
| `channels.feishu.domain`                          | Домен API (`feishu` или `lark`)               | `feishu`     |
| `channels.feishu.accounts.<id>.appId`             | App ID                                        | -            |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                    | -            |
| `channels.feishu.accounts.<id>.domain`            | Переопределение домена API для учётной записи | `feishu`     |
| `channels.feishu.dmPolicy`                        | Политика личных сообщений                     | `pairing`    |
| `channels.feishu.allowFrom`                       | Список разрешённых для ЛС (open_id)           | -            |
| `channels.feishu.groupPolicy`                     | Политика групп                                | `open`       |
| `channels.feishu.groupAllowFrom`                  | Список разрешённых групп                      | -            |
| `channels.feishu.groups.<chat_id>.requireMention` | Требовать @упоминание                         | `true`       |
| `channels.feishu.groups.<chat_id>.enabled`        | Включить группы                               | `true`       |
| `channels.feishu.textChunkLimit`                  | Размер чанка сообщения                        | `2000`       |
| `channels.feishu.mediaMaxMb`                      | Лимит размера медиа                           | `30`         |
| `channels.feishu.streaming`                       | Включить вывод потоковых карточек             | `true`       |
| `channels.feishu.blockStreaming`                  | Включить block streaming                      | `true`       |

---

## Справочник dmPolicy

| Значение      | Поведение                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------- |
| `"pairing"`   | **По умолчанию.** Неизвестные пользователи получают код сопряжения; требуется подтверждение |
| `"allowlist"` | Общаться могут только пользователи из `allowFrom`                                           |
| `"open"`      | Разрешить всех пользователей (требуется `"*"` в allowFrom)                                  |
| `"disabled"`  | Отключить личные сообщения                                                                  |

---

## Поддерживаемые типы сообщений

### Приём

- ✅ Текст
- ✅ Форматированный текст (post)
- ✅ Изображения
- ✅ Файлы
- ✅ Аудио
- ✅ Видео
- ✅ Стикеры

### Отправка

- ✅ Текст
- ✅ Изображения
- ✅ Файлы
- ✅ Аудио
- ⚠️ Форматированный текст (частичная поддержка)
