---
summary: "Push Gmail Pub/Sub, подключённый к вебхукам OpenClaw через gogcli"
read_when:
  - Подключение триггеров входящих писем Gmail к OpenClaw
  - Настройка Pub/Sub push для пробуждения агента
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Цель: наблюдение Gmail -> Pub/Sub push -> `gog gmail watch serve` -> вебхук OpenClaw.

## Предварительные запросы

- `gcloud` установлен и выполнен вход ([руководство по установке](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) установлен и авторизован для аккаунта Gmail ([gogcli.sh](https://gogcli.sh/)).
- Включены хуки OpenClaw (см. [Webhooks](/automation/webhook)).
- `tailscale` выполнен вход ([tailscale.com](https://tailscale.com/)). Поддерживаемая настройка использует Tailscale Funnel для публичного HTTPS-эндпоинта.
  Другие туннельные сервисы могут работать, но они DIY/не поддерживаются и требуют ручной настройки.
  На данный момент мы поддерживаем Tailscale.

Пример конфига хука (включение предустановленного маппинга Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Чтобы доставлять сводку Gmail на поверхность чата, переопределите пресет маппингом,
который задаёт `deliver` + необязательные `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Если нужен фиксированный канал, задайте `channel` + `to`. В противном случае `channel: "last"`
использует последний маршрут доставки (с откатом к WhatsApp).

Чтобы принудительно использовать более дешёвую модель для запусков Gmail, задайте `model` в маппинге
(`provider/model` или алиас). Если вы применяете `agents.defaults.models`, включите его там же.

Чтобы задать модель и уровень «thinking» по умолчанию специально для хуков Gmail, добавьте
`hooks.gmail.model` / `hooks.gmail.thinking` в ваш конфиг:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Примечания:

- Переопределения на уровне хука `model`/`thinking` в маппинге всё равно имеют приоритет над этими значениями по умолчанию.
- Порядок отката: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → основной (auth/rate-limit/timeouts).
- Если задан `agents.defaults.models`, модель Gmail должна быть в списке разрешённых.
- Контент хуков Gmail по умолчанию оборачивается внешними границами безопасности контента.
  Чтобы отключить (опасно), задайте `hooks.gmail.allowUnsafeExternalContent: true`.

Для дальнейшей кастомизации обработки payload добавьте `hooks.mappings` или модуль трансформации JS/TS
в `hooks.transformsDir` (см. [Webhooks](/automation/webhook)).

## Мастер (рекомендуется)

Используйте помощник OpenClaw, чтобы связать всё воедино (на macOS устанавливает зависимости через brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Значения по умолчанию:

- Использует Tailscale Funnel для публичного push-эндпоинта.
- Записывает конфиг `hooks.gmail` для `openclaw webhooks gmail run`.
- Включает пресет хука Gmail (`hooks.presets: ["gmail"]`).

Примечание о путях: когда включён `tailscale.mode`, OpenClaw автоматически устанавливает
`hooks.gmail.serve.path` в `/` и сохраняет публичный путь
`hooks.gmail.tailscale.path` (по умолчанию `/gmail-pubsub`), потому что Tailscale
удаляет префикс set-path перед проксированием.
Если необходимо, чтобы бэкенд получал путь с префиксом, задайте
`hooks.gmail.tailscale.target` (или `--tailscale-target`) как полный URL, например
`http://127.0.0.1:8788/gmail-pubsub`, и сопоставьте `hooks.gmail.serve.path`.

Нужен кастомный эндпоинт? Используйте `--push-endpoint <url>` или `--tailscale off`.

Примечание по платформе: на macOS мастер устанавливает `gcloud`, `gogcli` и `tailscale`
через Homebrew; на Linux установите их вручную заранее.

Автозапуск Gateway (шлюз) (рекомендуется):

- Когда заданы `hooks.enabled=true` и `hooks.gmail.account`, Gateway (шлюз) запускает
  `gog gmail watch serve` при загрузке и автоматически продлевает watch.
- Задайте `OPENCLAW_SKIP_GMAIL_WATCHER=1`, чтобы отказаться (полезно, если вы запускаете демон самостоятельно).
- Не запускайте ручной демон одновременно, иначе получите
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Ручной демон (запускает `gog gmail watch serve` + автопродление):

```bash
openclaw webhooks gmail run
```

## Одноразовая настройка

1. Выберите проект GCP, **которому принадлежит OAuth-клиент**, используемый `gog`.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Примечание: Gmail watch требует, чтобы тема Pub/Sub находилась в том же проекте, что и OAuth-клиент.

2. Включите API:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Создайте тему:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Разрешите публикацию push от Gmail:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Запуск watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Сохраните `history_id` из вывода (для отладки).

## Запуск обработчика push

Локальный пример (аутентификация общим токеном):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Примечания:

- `--token` защищает push-эндпоинт (`x-gog-token` или `?token=`).
- `--hook-url` указывает на OpenClaw `/hooks/gmail` (с маппингом; изолированный запуск + сводка в основной).
- `--include-body` и `--max-bytes` управляют фрагментом тела, отправляемым в OpenClaw.

Рекомендуется: `openclaw webhooks gmail run` оборачивает тот же поток и автоматически продлевает watch.

## Экспорт обработчика (расширенно, не поддерживается)

Если нужен туннель не Tailscale, подключите его вручную и используйте публичный URL в push-
подписке (не поддерживается, без защитных механизмов):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Используйте сгенерированный URL как push-эндпоинт:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Продакшн: используйте стабильный HTTPS-эндпоинт и настройте Pub/Sub OIDC JWT, затем выполните:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Тест

Отправьте сообщение в отслеживаемый почтовый ящик:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Проверьте состояние watch и историю:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Устранение неполадок

- `Invalid topicName`: несоответствие проекта (тема не в проекте OAuth-клиента).
- `User not authorized`: отсутствует `roles/pubsub.publisher` у темы.
- Пустые сообщения: push Gmail предоставляет только `historyId`; получайте через `gog gmail history`.

## Очистка

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
