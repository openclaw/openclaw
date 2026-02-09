---
summary: "Статус поддержки приложения Google Chat, возможности и конфигурация"
read_when:
  - Работа над возможностями канала Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Статус: готово для личных сообщений и пространств через вебхуки Google Chat API (только HTTP).

## Быстрая настройка (для начинающих)

1. Создайте проект Google Cloud и включите **Google Chat API**.
   - Перейдите: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Включите API, если он ещё не включён.
2. Создайте **Service Account**:
   - Нажмите **Create Credentials** > **Service Account**.
   - Задайте любое имя (например, `openclaw-chat`).
   - Оставьте права доступа пустыми (нажмите **Continue**).
   - Оставьте список субъектов с доступом пустым (нажмите **Done**).
3. Создайте и скачайте **JSON Key**:
   - В списке сервисных аккаунтов нажмите на только что созданный.
   - Перейдите на вкладку **Keys**.
   - Нажмите **Add Key** > **Create new key**.
   - Выберите **JSON** и нажмите **Create**.
4. Сохраните загруженный JSON‑файл на хосте шлюза Gateway (например, `~/.openclaw/googlechat-service-account.json`).
5. Создайте приложение Google Chat в [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Заполните **Application info**:
     - **App name**: (например, `OpenClaw`)
     - **Avatar URL**: (например, `https://openclaw.ai/logo.png`)
     - **Description**: (например, `Personal AI Assistant`)
   - Включите **Interactive features**.
   - В разделе **Functionality** отметьте **Join spaces and group conversations**.
   - В разделе **Connection settings** выберите **HTTP endpoint URL**.
   - В разделе **Triggers** выберите **Use a common HTTP endpoint URL for all triggers** и укажите публичный URL вашего шлюза с добавлением `/googlechat`.
     - _Совет: выполните `openclaw status`, чтобы узнать публичный URL вашего шлюза._
   - В разделе **Visibility** отметьте **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Введите свой адрес электронной почты (например, `user@example.com`) в текстовое поле.
   - Нажмите **Save** внизу страницы.
6. **Включите статус приложения**:
   - После сохранения **обновите страницу**.
   - Найдите раздел **App status** (обычно сверху или снизу после сохранения).
   - Измените статус на **Live - available to users**.
   - Снова нажмите **Save**.
7. Настройте OpenClaw, указав путь к сервисному аккаунту и audience вебхука:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Или в конфиге: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Задайте тип и значение audience вебхука (должны совпадать с конфигурацией приложения Chat).
9. Запустите шлюз. Google Chat будет отправлять POST‑запросы на путь вашего вебхука.

## Добавление в Google Chat

После запуска шлюза и добавления вашего email в список видимости:

1. Перейдите на [Google Chat](https://chat.google.com/).
2. Нажмите значок **+** рядом с **Direct Messages**.
3. В строке поиска (где обычно добавляют людей) введите **App name**, который вы настроили в Google Cloud Console.
   - **Примечание**: бот _не_ появится в списке «Marketplace», так как это приватное приложение. Его нужно искать по имени.
4. Выберите вашего бота из результатов.
5. Нажмите **Add** или **Chat**, чтобы начать диалог 1:1.
6. Отправьте «Hello», чтобы запустить ассистента!

## Публичный URL (только вебхуки)

Вебхуки Google Chat требуют публичный HTTPS‑эндпоинт. В целях безопасности **публикуйте в интернет только путь `/googlechat`**. Панель OpenClaw и другие чувствительные эндпоинты держите в приватной сети.

### Вариант A: Tailscale Funnel (рекомендуется)

Используйте Tailscale Serve для приватной панели и Funnel для публичного пути вебхука. Это сохраняет `/` приватным и открывает только `/googlechat`.

1. **Проверьте, к какому адресу привязан ваш шлюз:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Запомните IP‑адрес (например, `127.0.0.1`, `0.0.0.0` или ваш IP Tailscale, например `100.x.x.x`).

2. **Откройте панель только для tailnet (порт 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Публично откройте только путь вебхука:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Авторизуйте узел для доступа Funnel:**
   Если появится запрос, перейдите по URL авторизации, показанному в выводе, чтобы включить Funnel для этого узла в политике tailnet.

5. **Проверьте конфигурацию:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Ваш публичный URL вебхука:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Ваша приватная панель остаётся доступной только в tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Используйте публичный URL (без `:8443`) в конфигурации приложения Google Chat.

> Примечание: эта конфигурация сохраняется между перезагрузками. Чтобы удалить её позже, выполните `tailscale funnel reset` и `tailscale serve reset`.

### Вариант B: Обратный прокси (Caddy)

Если вы используете обратный прокси, например Caddy, проксируйте только конкретный путь:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

С такой конфигурацией любой запрос к `your-domain.com/` будет игнорироваться или возвращать 404, а `your-domain.com/googlechat` будет безопасно маршрутизирован в OpenClaw.

### Вариант C: Cloudflare Tunnel

Настройте правила ingress туннеля так, чтобы маршрутизировать только путь вебхука:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Как это работает

1. Google Chat отправляет POST‑запросы вебхука на шлюз. Каждый запрос включает заголовок `Authorization: Bearer <token>`.
2. OpenClaw проверяет токен относительно настроенных `audienceType` + `audience`:
   - `audienceType: "app-url"` → audience — это ваш HTTPS‑URL вебхука.
   - `audienceType: "project-number"` → audience — это номер проекта Cloud.
3. Сообщения маршрутизируются по пространству:
   - Личные сообщения используют ключ сеанса `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Пространства используют ключ сеанса `agent:<agentId>:googlechat:group:<spaceId>`.
4. Доступ к личным сообщениям по умолчанию — через сопряжение. Неизвестные отправители получают код сопряжения; подтвердите с помощью:
   - `openclaw pairing approve googlechat <code>`
5. Групповые пространства по умолчанию требуют @‑упоминания. Используйте `botUser`, если обнаружение упоминаний должно учитывать имя пользователя приложения.

## Цели

Используйте эти идентификаторы для доставки и списков разрешённых:

- Личные сообщения: `users/<userId>` или `users/<email>` (адреса электронной почты принимаются).
- Пространства: `spaces/<spaceId>`.

## Основные моменты конфига

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Примечания:

- Учётные данные сервисного аккаунта также можно передавать inline с помощью `serviceAccount` (строка JSON).
- Путь вебхука по умолчанию — `/googlechat`, если `webhookPath` не задан.
- Реакции доступны через инструмент `reactions` и `channels action`, когда включён `actions.reactions`.
- `typingIndicator` поддерживает `none`, `message` (по умолчанию) и `reaction` (реакции требуют OAuth пользователя).
- Вложения загружаются через Chat API и сохраняются в медиапайплайне (размер ограничен `mediaMaxMb`).

## Устранение неполадок

### 405 Method Not Allowed

Если в Google Cloud Logs Explorer отображаются ошибки вида:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Это означает, что обработчик вебхука не зарегистрирован. Распространённые причины:

1. **Канал не настроен**: в конфиге отсутствует раздел `channels.googlechat`. Проверьте с помощью:

   ```bash
   openclaw config get channels.googlechat
   ```

   Если возвращается «Config path not found», добавьте конфигурацию (см. [Основные моменты конфига](#config-highlights)).

2. **Плагин не включён**: проверьте статус плагина:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Если отображается «disabled», добавьте `plugins.entries.googlechat.enabled: true` в конфиг.

3. **Шлюз не перезапущен**: после добавления конфига перезапустите шлюз:

   ```bash
   openclaw gateway restart
   ```

Проверьте, что канал запущен:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Другие проблемы

- Проверьте `openclaw channels status --probe` на ошибки аутентификации или отсутствующую конфигурацию audience.
- Если сообщения не приходят, проверьте URL вебхука и подписки на события в приложении Chat.
- Если ответы блокируются проверкой упоминаний, задайте `botUser` равным имени ресурса пользователя приложения и проверьте `requireMention`.
- Используйте `openclaw logs --follow` при отправке тестового сообщения, чтобы увидеть, доходят ли запросы до шлюза.

Связанная документация:

- [Конфигурация Gateway (шлюз)](/gateway/configuration)
- [Безопасность](/gateway/security)
- [Реакции](/tools/reactions)
