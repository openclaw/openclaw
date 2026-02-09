---
summary: "Статус поддержки бота Microsoft Teams, возможности и конфигурация"
read_when:
  - Работа над возможностями канала MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (плагин)

> «Оставь надежду всяк сюда входящий».

Обновлено: 2026-01-21

Статус: поддерживаются текст и вложения в личных сообщениях; отправка файлов в каналы/группы требует `sharePointSiteId` + разрешений Graph (см. [Отправка файлов в групповых чатах](#sending-files-in-group-chats)). Опросы отправляются через Adaptive Cards.

## Требуется плагин

Microsoft Teams поставляется как плагин и не входит в базовую установку.

**Критическое изменение (2026.1.15):** MS Teams вынесен из ядра. Если вы его используете, необходимо установить плагин.

Объяснимо: это делает базовые установки легче и позволяет зависимостям MS Teams обновляться независимо.

Установка через CLI (реестр npm):

```bash
openclaw plugins install @openclaw/msteams
```

Локальная установка (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/msteams
```

Если при конфигурации/онбординге выбран Teams и обнаружен git-чекаут,
OpenClaw автоматически предложит путь локальной установки.

Подробности: [Plugins](/tools/plugin)

## Быстрая настройка (для начинающих)

1. Установите плагин Microsoft Teams.
2. Создайте **Azure Bot** (App ID + client secret + tenant ID).
3. Настройте OpenClaw с этими учетными данными.
4. Опубликуйте `/api/messages` (по умолчанию порт 3978) через публичный URL или туннель.
5. Установите пакет приложения Teams и запустите Gateway (шлюз).

Минимальный конфиг:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Примечание: групповые чаты по умолчанию заблокированы (`channels.msteams.groupPolicy: "allowlist"`). Чтобы разрешить ответы в группах, установите `channels.msteams.groupAllowFrom` (или используйте `groupPolicy: "open"`, чтобы разрешить любого участника, с обязательным упоминанием).

## Цели

- Общение с OpenClaw через личные сообщения Teams, групповые чаты или каналы.
- Детерминированная маршрутизация: ответы всегда возвращаются в тот же канал, откуда пришли.
- Безопасное поведение каналов по умолчанию (требуются упоминания, если не настроено иначе).

## Запись конфига

По умолчанию Microsoft Teams разрешено записывать обновления конфига, инициированные `/config set|unset` (требуется `commands.config: true`).

Отключить:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Контроль доступа (личные сообщения + группы)

**Доступ к личным сообщениям**

- По умолчанию: `channels.msteams.dmPolicy = "pairing"`. Неизвестные отправители игнорируются до одобрения.
- `channels.msteams.allowFrom` принимает AAD object ID, UPN или отображаемые имена. Мастер настраивания разрешает имена в ID через Microsoft Graph при наличии учетных данных.

**Доступ к группам**

- По умолчанию: `channels.msteams.groupPolicy = "allowlist"` (заблокировано, пока вы не добавите `groupAllowFrom`). Используйте `channels.defaults.groupPolicy` для переопределения значения по умолчанию, если оно не задано.
- `channels.msteams.groupAllowFrom` управляет тем, какие отправители могут инициировать события в групповых чатах/каналах (с откатом к `channels.msteams.allowFrom`).
- Установите `groupPolicy: "open"`, чтобы разрешить любого участника (по умолчанию все равно требуется упоминание).
- Чтобы запретить **все каналы**, установите `channels.msteams.groupPolicy: "disabled"`.

Пример:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Списки разрешённых Teams + каналов**

- Ограничивайте ответы в группах/каналах, перечисляя команды и каналы в `channels.msteams.teams`.
- Ключами могут быть ID или имена команд; ключами каналов — ID диалогов или имена.
- Когда включен `groupPolicy="allowlist"` и присутствует allowlist команд, принимаются только перечисленные команды/каналы (с обязательным упоминанием).
- Мастер конфигурации принимает записи `Team/Channel` и сохраняет их за вас.
- При запуске OpenClaw разрешает имена команд/каналов и пользователей из allowlist в ID (если позволяют разрешения Graph)
  и логирует сопоставление; неразрешённые записи сохраняются как введены.

Пример:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Как это работает

1. Установите плагин Microsoft Teams.
2. Создайте **Azure Bot** (App ID + secret + tenant ID).
3. Соберите **пакет приложения Teams**, который ссылается на бота и включает разрешения RSC ниже.
4. Загрузите/установите приложение Teams в команду (или в личную область для личных сообщений).
5. Настройте `msteams` в `~/.openclaw/openclaw.json` (или через переменные окружения) и запустите Gateway (шлюз).
6. Gateway (шлюз) по умолчанию принимает трафик вебхуков Bot Framework на `/api/messages`.

## Настройка Azure Bot (Предварительные требования)

Перед конфигурацией OpenClaw необходимо создать ресурс Azure Bot.

### Шаг 1: Создание Azure Bot

1. Перейдите на [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Заполните вкладку **Basics**:

   | Поле               | Значение                                                                                   |
   | ------------------ | ------------------------------------------------------------------------------------------ |
   | **Bot handle**     | Имя вашего бота, например `openclaw-msteams` (должно быть уникальным)   |
   | **Subscription**   | Выберите подписку Azure                                                                    |
   | **Resource group** | Создайте новую или используйте существующую                                                |
   | **Pricing tier**   | **Free** для разработки/тестирования                                                       |
   | **Type of App**    | **Single Tenant** (рекомендуется — см. примечание ниже) |
   | **Creation type**  | **Create new Microsoft App ID**                                                            |

> **Уведомление об устаревании:** Создание новых мультиарендных ботов было прекращено после 2025-07-31. Для новых ботов используйте **Single Tenant**.

3. Нажмите **Review + create** → **Create** (подождите ~1–2 минуты)

### Шаг 2: Получение учетных данных

1. Перейдите в ресурс Azure Bot → **Configuration**
2. Скопируйте **Microsoft App ID** → это ваш `appId`
3. Нажмите **Manage Password** → перейдите в App Registration
4. В **Certificates & secrets** → **New client secret** → скопируйте **Value** → это ваш `appPassword`
5. Перейдите в **Overview** → скопируйте **Directory (tenant) ID** → это ваш `tenantId`

### Шаг 3: Настройка конечной точки сообщений

1. В Azure Bot → **Configuration**
2. Установите **Messaging endpoint** на URL вашего вебхука:
   - Продакшн: `https://your-domain.com/api/messages`
   - Локальная разработка: используйте туннель (см. [Локальная разработка](#local-development-tunneling) ниже)

### Шаг 4: Включение канала Teams

1. В Azure Bot → **Channels**
2. Нажмите **Microsoft Teams** → Configure → Save
3. Примите Условия использования

## Локальная разработка (туннелирование)

Teams не может обратиться к `localhost`. Для локальной разработки используйте туннель:

**Вариант A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Вариант B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (альтернатива)

Вместо ручного создания ZIP-манифеста вы можете использовать [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Нажмите **+ New app**
2. Заполните базовую информацию (имя, описание, данные разработчика)
3. Перейдите в **App features** → **Bot**
4. Выберите **Enter a bot ID manually** и вставьте App ID вашего Azure Bot
5. Отметьте области: **Personal**, **Team**, **Group Chat**
6. Нажмите **Distribute** → **Download app package**
7. В Teams: **Apps** → **Manage your apps** → **Upload a custom app** → выберите ZIP

Часто это проще, чем редактировать JSON-манифесты вручную.

## Тестирование бота

**Вариант A: Azure Web Chat (сначала проверьте вебхук)**

1. В Azure Portal → ресурс Azure Bot → **Test in Web Chat**
2. Отправьте сообщение — вы должны увидеть ответ
3. Это подтверждает, что конечная точка вебхука работает до настройки Teams

**Вариант B: Teams (после установки приложения)**

1. Установите приложение Teams (sideload или каталог организации)
2. Найдите бота в Teams и отправьте личное сообщение
3. Проверьте логи Gateway (шлюза) на входящую активность

## Настройка (минимальная, только текст)

1. **Установка плагина Microsoft Teams**
   - Из npm: `openclaw plugins install @openclaw/msteams`
   - Из локального чекаута: `openclaw plugins install ./extensions/msteams`

2. **Регистрация бота**
   - Создайте Azure Bot (см. выше) и запишите:
     - App ID
     - Client secret (пароль приложения)
     - Tenant ID (single-tenant)

3. **Манифест приложения Teams**
   - Добавьте запись `bot` с `botId = <App ID>`.
   - Области: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (обязательно для обработки файлов в личной области).
   - Добавьте разрешения RSC (ниже).
   - Создайте иконки: `outline.png` (32x32) и `color.png` (192x192).
   - Упакуйте все три файла в ZIP: `manifest.json`, `outline.png`, `color.png`.

4. **Настройка OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Вы также можете использовать переменные окружения вместо ключей конфига:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Конечная точка бота**
   - Установите Messaging Endpoint Azure Bot в:
     - `https://<host>:3978/api/messages` (или выбранный вами путь/порт).

6. **Запуск Gateway (шлюза)**
   - Канал Teams запускается автоматически, когда плагин установлен и существует конфиг `msteams` с учетными данными.

## Контекст истории

- `channels.msteams.historyLimit` управляет тем, сколько последних сообщений канала/группы включается в prompt.
- С откатом к `messages.groupChat.historyLimit`. Установите `0`, чтобы отключить (по умолчанию 50).
- История личных сообщений может быть ограничена с помощью `channels.msteams.dmHistoryLimit` (повороты пользователя). Переопределения для конкретных пользователей: `channels.msteams.dms["<user_id>"].historyLimit`.

## Текущие разрешения Teams RSC (манифест)

Это **существующие resourceSpecific разрешения** в нашем манифесте приложения Teams. Они применяются только внутри команды/чата, где установлено приложение.

**Для каналов (область команды):**

- `ChannelMessage.Read.Group` (Application) — получение всех сообщений канала без @упоминания
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Для групповых чатов:**

- `ChatMessage.Read.Chat` (Application) — получение всех сообщений группового чата без @упоминания

## Пример манифеста Teams (сокращённый)

Минимальный, корректный пример с обязательными полями. Замените ID и URL.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Ограничения манифеста (обязательные поля)

- `bots[].botId` **должен** совпадать с Azure Bot App ID.
- `webApplicationInfo.id` **должен** совпадать с Azure Bot App ID.
- `bots[].scopes` должен включать поверхности, которые вы планируете использовать (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` требуется для обработки файлов в личной области.
- `authorization.permissions.resourceSpecific` должен включать чтение/отправку каналов, если вы хотите трафик каналов.

### Обновление существующего приложения

Чтобы обновить уже установленное приложение Teams (например, для добавления разрешений RSC):

1. Обновите ваш `manifest.json` с новыми настройками
2. **Увеличьте поле `version`** (например, `1.0.0` → `1.1.0`)
3. **Переупакуйте ZIP** манифеста с иконками (`manifest.json`, `outline.png`, `color.png`)
4. Загрузите новый ZIP:
   - **Вариант A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → найдите приложение → Upload new version
   - **Вариант B (Sideload):** В Teams → Apps → Manage your apps → Upload a custom app
5. **Для каналов команды:** переустановите приложение в каждой команде, чтобы новые разрешения вступили в силу
6. **Полностью закройте и перезапустите Teams** (не просто закройте окно), чтобы очистить кэш метаданных приложения

## Возможности: только RSC vs Graph

### С **только Teams RSC** (приложение установлено, без разрешений Graph API)

Работает:

- Чтение **текста** сообщений каналов.
- Отправка **текста** сообщений каналов.
- Получение вложений файлов в **личных сообщениях**.

Не работает:

- **Изображения или файлы** в каналах/группах (в полезной нагрузке только HTML-заглушка).
- Загрузка вложений, хранящихся в SharePoint/OneDrive.
- Чтение истории сообщений (кроме события живого вебхука).

### С **Teams RSC + разрешениями Microsoft Graph (Application)**

Добавляется:

- Загрузка размещённого контента (изображения, вставленные в сообщения).
- Загрузка файловых вложений из SharePoint/OneDrive.
- Чтение истории сообщений каналов/чатов через Graph.

### RSC vs Graph API

| Возможность                      | Разрешения RSC                           | Graph API                                               |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| **Сообщения в реальном времени** | Да (через вебхук)     | Нет (только опрос)                   |
| **Исторические сообщения**       | Нет                                      | Да (можно запрашивать историю)       |
| **Сложность настройки**          | Только манифест приложения               | Требуется согласие администратора + поток токенов       |
| **Работа офлайн**                | Нет (должен работать) | Да (можно запрашивать в любое время) |

**Итог:** RSC — для прослушивания в реальном времени; Graph API — для доступа к истории. Чтобы догонять пропущенные сообщения в офлайне, нужен Graph API с `ChannelMessage.Read.All` (требуется согласие администратора).

## Медиа и история с Graph (требуется для каналов)

Если вам нужны изображения/файлы в **каналах** или получение **истории сообщений**, необходимо включить разрешения Microsoft Graph и выдать согласие администратора.

1. В Entra ID (Azure AD) → **App Registration** добавьте разрешения Microsoft Graph **Application**:
   - `ChannelMessage.Read.All` (вложения каналов + история)
   - `Chat.Read.All` или `ChatMessage.Read.All` (групповые чаты)
2. **Выдайте согласие администратора** для арендатора.
3. Увеличьте **версию манифеста** приложения Teams, повторно загрузите и **переустановите приложение в Teams**.
4. **Полностью закройте и перезапустите Teams**, чтобы очистить кэш метаданных приложения.

## Известные ограничения

### Тайм-ауты вебхука

Teams доставляет сообщения через HTTP-вебхук. Если обработка занимает слишком много времени (например, медленные ответы LLM), вы можете увидеть:

- Тайм-ауты Gateway (шлюза)
- Повторные попытки Teams (вызывающие дубликаты)
- Потерянные ответы

OpenClaw решает это, быстро возвращая ответ и отправляя сообщения проактивно, но очень медленные ответы всё ещё могут вызывать проблемы.

### Форматирование

Markdown в Teams более ограничен, чем в Slack или Discord:

- Базовое форматирование работает: **жирный**, _курсив_, `code`, ссылки
- Сложный markdown (таблицы, вложенные списки) может отображаться некорректно
- Adaptive Cards поддерживаются для опросов и произвольных карточек (см. ниже)

## Конфигурация

Ключевые настройки (см. `/gateway/configuration` для общих шаблонов каналов):

- `channels.msteams.enabled`: включить/выключить канал.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: учетные данные бота.
- `channels.msteams.webhook.port` (по умолчанию `3978`)
- `channels.msteams.webhook.path` (по умолчанию `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (по умолчанию: pairing)
- `channels.msteams.allowFrom`: список разрешённых для личных сообщений (AAD object ID, UPN или отображаемые имена). Мастер разрешает имена в ID во время настройки при наличии доступа Graph.
- `channels.msteams.textChunkLimit`: размер чанка исходящего текста.
- `channels.msteams.chunkMode`: `length` (по умолчанию) или `newline` для разделения по пустым строкам (границы абзацев) перед разбиением по длине.
- `channels.msteams.mediaAllowHosts`: список разрешённых хостов для входящих вложений (по умолчанию домены Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: список разрешённых хостов для добавления заголовков Authorization при повторах загрузки медиа (по умолчанию хосты Graph + Bot Framework).
- `channels.msteams.requireMention`: требовать @упоминание в каналах/группах (по умолчанию true).
- `channels.msteams.replyStyle`: `thread | top-level` (см. [Стиль ответа](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: переопределение для команды.
- `channels.msteams.teams.<teamId>.requireMention`: переопределение для команды.
- `channels.msteams.teams.<teamId>.tools`: значения по умолчанию переопределений политик инструментов для команды (`allow`/`deny`/`alsoAllow`), используемые, когда отсутствует переопределение канала.
- `channels.msteams.teams.<teamId>.toolsBySender`: значения по умолчанию переопределений политик инструментов для команды и отправителя (`"*"` поддерживает wildcard).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: переопределение для канала.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: переопределение для канала.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: переопределения политик инструментов для канала (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: переопределения политик инструментов для канала и отправителя (`"*"` поддерживает wildcard).
- `channels.msteams.sharePointSiteId`: ID сайта SharePoint для загрузки файлов в групповых чатах/каналах (см. [Отправка файлов в групповых чатах](#sending-files-in-group-chats)).

## Маршрутизация и сессии

- Ключи сессий следуют стандартному формату агента (см. [/concepts/session](/concepts/session)):
  - Личные сообщения используют основную сессию (`agent:<agentId>:<mainKey>`).
  - Сообщения каналов/групп используют ID диалога:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Стиль ответа: Threads vs Posts

Недавно Teams представил два UI-стиля каналов поверх одной и той же модели данных:

| Стиль                                        | Описание                                             | Рекомендуемый `replyStyle`                 |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| **Posts** (классический)  | Сообщения отображаются карточками с ответами в треде | `thread` (по умолчанию) |
| **Threads** (как в Slack) | Сообщения идут линейно, как в Slack                  | `top-level`                                |

**Проблема:** API Teams не сообщает, какой UI-стиль используется в канале. Если выбрать неверный `replyStyle`:

- `thread` в канале со стилем Threads → ответы выглядят неудачно вложенными
- `top-level` в канале со стилем Posts → ответы появляются как отдельные верхнеуровневые посты, а не в треде

**Решение:** Настройте `replyStyle` для каждого канала в зависимости от его настройки:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Вложения и изображения

**Текущие ограничения:**

- **Личные сообщения:** изображения и файловые вложения работают через API файлов бота Teams.
- **Каналы/группы:** вложения хранятся в M365 (SharePoint/OneDrive). Полезная нагрузка вебхука содержит только HTML-заглушку, а не байты файла. **Для загрузки вложений каналов требуются разрешения Graph API**.

Без разрешений Graph сообщения каналов с изображениями будут получены как только текст (содержимое изображения боту недоступно).
По умолчанию OpenClaw загружает медиа только с хостов Microsoft/Teams. Переопределите с помощью `channels.msteams.mediaAllowHosts` (используйте `["*"]`, чтобы разрешить любой хост).
Заголовки Authorization добавляются только для хостов из `channels.msteams.mediaAuthAllowHosts` (по умолчанию хосты Graph + Bot Framework). Держите этот список строгим (избегайте многопользовательских суффиксов).

## Отправка файлов в групповых чатах

Боты могут отправлять файлы в личных сообщениях, используя поток FileConsentCard (встроенный). Однако **отправка файлов в групповых чатах/каналах** требует дополнительной настройки:

| Контекст                                            | Как отправляются файлы                                   | Требуемая настройка                             |
| --------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| **Личные сообщения**                                | FileConsentCard → пользователь принимает → бот загружает | Работает из коробки                             |
| **Групповые чаты/каналы**                           | Загрузка в SharePoint → ссылка для доступа               | Требуется `sharePointSiteId` + разрешения Graph |
| **Изображения (любой контекст)** | Base64 inline                                            | Работает из коробки                             |

### Почему группам нужен SharePoint

У ботов нет личного диска OneDrive (конечная точка Graph API `/me/drive` не работает для application identity). Чтобы отправлять файлы в групповых чатах/каналах, бот загружает их на **сайт SharePoint** и создаёт ссылку общего доступа.

### Настройка

1. **Добавьте разрешения Graph API** в Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) — загрузка файлов в SharePoint
   - `Chat.Read.All` (Application) — необязательно, включает ссылки общего доступа для каждого пользователя

2. **Выдайте согласие администратора** для арендатора.

3. **Получите ID сайта SharePoint:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Настройте OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Поделиться поведением

| Разрешение                              | Поделиться поведением                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Только `Sites.ReadWrite.All`            | Ссылка для всей организации (доступна всем в организации)       |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Ссылка для каждого пользователя (доступ только участникам чата) |

Общий доступ для каждого пользователя более безопасен, так как файл доступен только участникам чата. Если отсутствует разрешение `Chat.Read.All`, бот использует общий доступ для организации.

### Резервное поведение

| Сценарий                                           | Результат                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Групповой чат + файл + настроен `sharePointSiteId` | Загрузка в SharePoint, отправка ссылки                                                      |
| Групповой чат + файл + нет `sharePointSiteId`      | Попытка загрузки в OneDrive (может не сработать), отправка только текста |
| Личный чат + файл                                  | Поток FileConsentCard (работает без SharePoint)                          |
| Любой контекст + изображение                       | Base64 inline (работает без SharePoint)                                  |

### Место хранения файлов

Загруженные файлы хранятся в папке `/OpenClawShared/` в стандартной библиотеке документов настроенного сайта SharePoint.

## Опросы (Adaptive Cards)

OpenClaw отправляет опросы Teams как Adaptive Cards (в Teams нет нативного API опросов).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Голоса записываются Gateway (шлюзом) в `~/.openclaw/msteams-polls.json`.
- Gateway (шлюз) должен оставаться онлайн для записи голосов.
- Автоматическая публикация итогов опросов пока не реализована (при необходимости проверяйте файл хранилища).

## Adaptive Cards (произвольные)

Отправляйте любой JSON Adaptive Card пользователям или в диалоги Teams с помощью инструмента или CLI `message`.

Параметр `card` принимает объект JSON Adaptive Card. При указании `card` текст сообщения необязателен.

**Инструмент агента:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

См. [документацию Adaptive Cards](https://adaptivecards.io/) для схемы и примеров. Детали целевых форматов см. ниже в разделе [Целевые форматы](#target-formats).

## Целевые форматы

Цели MSTeams используют префиксы для различения пользователей и диалогов:

| Тип цели                                   | Формат                           | Пример                                                                   |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| Пользователь (по ID)    | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                              |
| Пользователь (по имени) | `user:<display-name>`            | `user:John Smith` (требуется Graph API)               |
| Группа/канал                               | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                 |
| Группа/канал (raw)      | `<conversation-id>`              | `19:abc123...@thread.tacv2` (если содержит `@thread`) |

**Примеры CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Примеры инструментов агента:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Примечание: без префикса `user:` имена по умолчанию разрешаются как группы/команды. Всегда используйте `user:` при обращении к людям по отображаемому имени.

## Проактивные сообщения

- Проактивные сообщения возможны только **после** того, как пользователь взаимодействовал, так как мы сохраняем ссылки диалогов в этот момент.
- См. `/gateway/configuration` для `dmPolicy` и ограничений allowlist.

## ID команд и каналов (частая ошибка)

Параметр запроса `groupId` в URL Teams **НЕ** является ID команды для конфигурации. Извлекайте ID из пути URL:

**URL команды:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL канала:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Для конфига:**

- ID команды = сегмент пути после `/team/` (URL-decoded, например `19:Bk4j...@thread.tacv2`)
- ID канала = сегмент пути после `/channel/` (URL-decoded)
- **Игнорируйте** параметр запроса `groupId`

## Приватные каналы

Поддержка ботов в приватных каналах ограничена:

| Функция                                                  | Стандартные каналы | Приватные каналы                       |
| -------------------------------------------------------- | ------------------ | -------------------------------------- |
| Установка бота                                           | Да                 | Ограничено                             |
| Сообщения в реальном времени (вебхук) | Да                 | Может не работать                      |
| Разрешения RSC                                           | Да                 | Могут вести себя иначе                 |
| @упоминания                                 | Да                 | Если бот доступен                      |
| История Graph API                                        | Да                 | Да (с разрешениями) |

**Обходные пути, если приватные каналы не работают:**

1. Используйте стандартные каналы для взаимодействия с ботом
2. Используйте личные сообщения — пользователи всегда могут написать боту напрямую
3. Используйте Graph API для доступа к истории (требуется `ChannelMessage.Read.All`)

## Устранение неполадок

### Распространённые проблемы

- **Изображения не отображаются в каналах:** отсутствуют разрешения Graph или согласие администратора. Переустановите приложение Teams и полностью закройте/откройте Teams.
- **Нет ответов в канале:** по умолчанию требуются упоминания; установите `channels.msteams.requireMention=false` или настройте для команды/канала.
- **Несоответствие версий (Teams показывает старый манифест):** удалите и снова добавьте приложение и полностью перезапустите Teams для обновления.
- **401 Unauthorized от вебхука:** ожидаемо при ручном тестировании без JWT Azure — означает, что конечная точка доступна, но аутентификация не прошла. Используйте Azure Web Chat для корректного теста.

### Ошибки загрузки манифеста

- **«Icon file cannot be empty»:** манифест ссылается на иконки нулевого размера. Создайте корректные PNG-иконки (32x32 для `outline.png`, 192x192 для `color.png`).
- **«webApplicationInfo.Id already in use»:** приложение всё ещё установлено в другой команде/чате. Найдите и удалите его или подождите 5–10 минут для распространения.
- **«Something went wrong» при загрузке:** загрузите через [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), откройте DevTools браузера (F12) → вкладка Network и проверьте тело ответа с фактической ошибкой.
- **Сбой sideload:** попробуйте «Upload an app to your org's app catalog» вместо «Upload a custom app» — это часто обходит ограничения sideload.

### Разрешения RSC не работают

1. Проверьте, что `webApplicationInfo.id` точно совпадает с App ID вашего бота
2. Повторно загрузите приложение и переустановите его в команде/чате
3. Убедитесь, что администратор организации не заблокировал разрешения RSC
4. Подтвердите, что используется правильная область: `ChannelMessage.Read.Group` для команд, `ChatMessage.Read.Chat` для групповых чатов

## Ссылки

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) — руководство по настройке Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) — создание и управление приложениями Teams
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (для каналов/групп требуется Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
