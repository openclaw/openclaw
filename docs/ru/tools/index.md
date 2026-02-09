---
summary: "Поверхность агентных инструментов для OpenClaw (браузер, canvas, узлы, сообщения, cron), заменяющая устаревшие навыки `openclaw-*`"
read_when:
  - При добавлении или изменении инструментов агента
  - При выводе из эксплуатации или изменении навыков `openclaw-*`
title: "Инструменты"
---

# Инструменты (OpenClaw)

OpenClaw предоставляет **первоклассные инструменты агента** для браузера, canvas, узлов и cron.
Они заменяют старые навыки `openclaw-*`: инструменты типизированы, без запуска оболочки,
и агенту следует полагаться на них напрямую.

## Отключение инструментов

Вы можете глобально разрешать/запрещать инструменты через `tools.allow` / `tools.deny` в `openclaw.json`
(запрет имеет приоритет). Это предотвращает отправку запрещённых инструментов провайдерам моделей.

```json5
{
  tools: { deny: ["browser"] },
}
```

Примечания:

- Сопоставление не чувствительно к регистру.
- Поддерживаются подстановки `*` (`"*"` означает все инструменты).
- Если `tools.allow` ссылается только на неизвестные или не загруженные имена инструментов плагинов, OpenClaw записывает предупреждение и игнорирует список разрешённых, чтобы базовые инструменты оставались доступными.

## Профили инструментов (базовый список разрешённых)

`tools.profile` задаёт **базовый список разрешённых инструментов** перед `tools.allow`/`tools.deny`.
Переопределение для агента: `agents.list[].tools.profile`.

Профили:

- `minimal`: только `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: без ограничений (то же, что и unset)

Пример (по умолчанию только сообщения, дополнительно разрешить инструменты Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Пример (профиль для кодинга, но запрет exec/process везде):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Пример (глобальный профиль кодинга, агент поддержки — только сообщения):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Политика инструментов для конкретных провайдеров

Используйте `tools.byProvider`, чтобы **дополнительно ограничить** инструменты для конкретных провайдеров
(или одного `provider/model`), не меняя глобальные значения по умолчанию.
Переопределение для агента: `agents.list[].tools.byProvider`.

Это применяется **после** базового профиля инструментов и **до** списков разрешения/запрета,
поэтому может только сужать набор инструментов.
Ключи провайдеров принимают либо `provider` (например, `google-antigravity`), либо
`provider/model` (например, `openai/gpt-5.2`).

Пример (сохранить глобальный профиль кодинга, но минимальные инструменты для Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Пример (provider/model-specific allowlist for the flaky endpoint):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Пример (переопределение для агента для одного провайдера):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Группы инструментов (сокращения)

Политики инструментов (глобальные, агентские, sandbox) поддерживают записи `group:*`, которые разворачиваются в несколько инструментов.
Используйте их в `tools.allow` / `tools.deny`.

Доступные группы:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: все встроенные инструменты OpenClaw (исключая плагины провайдеров)

Пример (разрешить только инструменты работы с файлами + браузер):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Плагины + инструменты

Плагины могут регистрировать **дополнительные инструменты** (и команды CLI) помимо базового набора. См.
См. [Plugins](/tools/plugin) для установки и конфигурации и [Skills](/tools/skills) — как
подсказки по использованию инструментов внедряются в промпты. Некоторые плагины поставляются со своими навыками
наряду с инструментами (например, плагин голосовых вызовов).

Необязательные инструменты плагинов:

- [Lobster](/tools/lobster): типизированная среда выполнения рабочих процессов с возобновляемыми подтверждениями (требуется CLI Lobster на хосте шлюза Gateway).
- [LLM Task](/tools/llm-task): шаг LLM только с JSON для структурированного вывода рабочего процесса (необязательная валидация схемы).

## Инвентаризация инструментов

### `apply_patch`

Применение структурированных патчей к одному или нескольким файлам. Используйте для многофрагментных правок.
Экспериментально: включается через `tools.exec.applyPatch.enabled` (только модели OpenAI).

### `exec`

Запуск команд оболочки в рабочем пространстве.

Основные параметры:

- `command` (обязательно)
- `yieldMs` (автопереход в фон по таймауту, по умолчанию 10000)
- `background` (немедленный фон)
- `timeout` (секунды; завершает процесс при превышении, по умолчанию 1800)
- `elevated` (bool; запуск на хосте, если включён/разрешён повышенный режим; меняет поведение только когда агент в sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/имя узла для `host=node`)
- Нужен настоящий TTY? Установите `pty: true`.

Примечания:

- Возвращает `status: "running"` с `sessionId` при работе в фоне.
- Используйте `process` для опроса/логирования/записи/завершения/очистки фоновых сеансов.
- Если `process` запрещён, `exec` выполняется синхронно и игнорирует `yieldMs`/`background`.
- `elevated` контролируется `tools.elevated` плюс любым переопределением `agents.list[].tools.elevated` (оба должны разрешать) и является псевдонимом для `host=gateway` + `security=full`.
- `elevated` меняет поведение только когда агент в sandbox (иначе это no-op).
- `host=node` может нацеливаться на сопутствующее приложение для macOS или headless-хост узла (`openclaw node run`).
- Подтверждения и списки разрешённых gateway/узлов: [Exec approvals](/tools/exec-approvals).

### `process`

Управление фоновыми сеансами exec.

Основные действия:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Примечания:

- `poll` возвращает новый вывод и статус завершения по окончании.
- `log` поддерживает построчные `offset`/`limit` (опустите `offset`, чтобы получить последние N строк).
- `process` имеет область видимости «на агента»; сеансы других агентов не видны.

### `web_search`

Поиск в интернете с использованием API Brave Search.

Основные параметры:

- `query` (обязательно)
- `count` (1–10; значение по умолчанию из `tools.web.search.maxResults`)

Примечания:

- Требуется ключ API Brave (рекомендуется: `openclaw configure --section web` или установить `BRAVE_API_KEY`).
- Включается через `tools.web.search.enabled`.
- Ответы кэшируются (по умолчанию 15 мин).
- См. [Web tools](/tools/web) для настройки.

### `web_fetch`

Загрузка и извлечение читаемого содержимого по URL (HTML → markdown/текст).

Основные параметры:

- `url` (обязательно)
- `extractMode` (`markdown` | `text`)
- `maxChars` (обрезка длинных страниц)

Примечания:

- Включается через `tools.web.fetch.enabled`.
- `maxChars` ограничивается `tools.web.fetch.maxCharsCap` (по умолчанию 50000).
- Ответы кэшируются (по умолчанию 15 мин).
- Для сайтов с интенсивным JS предпочтительнее использовать инструмент браузера.
- См. [Web tools](/tools/web) для настройки.
- [Firecrawl](/tools/firecrawl) для необязательного антибот‑фолбэка.

### `browser`

Управление выделенным браузером под управлением OpenClaw.

Основные действия:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (возвращает блок изображения + `MEDIA:<path>`)
- `act` (действия UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Управление профилями:

- `profiles` — список всех профилей браузера со статусом
- `create-profile` — создать новый профиль с автоматически выделенным портом (или `cdpUrl`)
- `delete-profile` — остановить браузер, удалить пользовательские данные, убрать из конфига (только локально)
- `reset-profile` — завершить «осиротевший» процесс на порту профиля (только локально)

Общие параметры:

- `profile` (необязательно; по умолчанию `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (необязательно; выбор конкретного id/имени узла)
  Примечания:
- Требуется `browser.enabled=true` (по умолчанию `true`; установите `false`, чтобы отключить).
- Все действия принимают необязательный параметр `profile` для поддержки нескольких экземпляров.
- Если `profile` не указан, используется `browser.defaultProfile` (по умолчанию "chrome").
- Имена профилей: только строчные буквы/цифры и дефисы (макс. 64 символа).
- Диапазон портов: 18800–18899 (~макс. 100 профилей).
- Удалённые профили — только подключение (без start/stop/reset).
- Если подключён узел с поддержкой браузера, инструмент может автоматически направляться к нему (если не закрепить `target`).
- `snapshot` по умолчанию `ai` при установленном Playwright; используйте `aria` для дерева доступности.
- `snapshot` также поддерживает параметры role‑snapshot (`interactive`, `compact`, `depth`, `selector`), которые возвращают ссылки вида `e12`.
- `act` требует `ref` из `snapshot` (числовой `12` из AI‑снимков или `e12` из role‑снимков); используйте `evaluate` для редких случаев с CSS‑селекторами.
- Избегайте `act` → `wait` по умолчанию; используйте только в исключительных случаях (нет надёжного состояния UI для ожидания).
- `upload` может при необходимости передать `ref` для автоклика после подготовки.
- `upload` также поддерживает `inputRef` (aria‑ref) или `element` (CSS‑селектор) для прямой установки `<input type="file">`.

### `canvas`

Управление Canvas узла (present, eval, snapshot, A2UI).

Основные действия:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (возвращает блок изображения + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Примечания:

- Под капотом используется gateway `node.invoke`.
- Если `node` не указан, инструмент выбирает значение по умолчанию (один подключённый узел или локальный mac‑узел).
- A2UI — только v0.8 (без `createSurface`); CLI отклоняет JSONL v0.9 с ошибками строк.
- Быстрый смоук‑тест: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Обнаружение и нацеливание сопряжённых узлов; отправка уведомлений; захват камеры/экрана.

Основные действия:

- `status`, `describe`
- `pending`, `approve`, `reject` (сопряжение)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Примечания:

- Команды камеры/экрана требуют, чтобы приложение узла было на переднем плане.
- Изображения возвращают блоки изображений + `MEDIA:<path>`.
- Видео возвращают `FILE:<path>` (mp4).
- Местоположение возвращает JSON‑полезную нагрузку (lat/lon/accuracy/timestamp).
- Параметры `run`: массив argv `command`; необязательные `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Пример (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Анализ изображения с использованием настроенной модели изображений.

Основные параметры:

- `image` (обязательный путь или URL)
- `prompt` (необязательно; по умолчанию "Describe the image.")
- `model` (необязательное переопределение)
- `maxBytesMb` (необязательное ограничение размера)

Примечания:

- Доступно только когда настроен `agents.defaults.imageModel` (основная или резервные), либо когда неявная модель изображений может быть выведена из вашей модели по умолчанию + настроенной аутентификации (best‑effort).
- Использует модель изображений напрямую (независимо от основной модели чата).

### `message`

Отправка сообщений и действий каналов через Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Основные действия:

- `send` (текст + необязательные медиа; MS Teams также поддерживает `card` для Adaptive Cards)
- `poll` (опросы WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Примечания:

- `send` маршрутизирует WhatsApp через Gateway (шлюз); другие каналы идут напрямую.
- `poll` использует Gateway (шлюз) для WhatsApp и MS Teams; опросы Discord идут напрямую.
- Когда вызов инструмента сообщений привязан к активному сеансу чата, отправки ограничиваются целью этого сеанса, чтобы избежать утечек между контекстами.

### `cron`

Управление cron‑задачами Gateway (шлюз) и пробуждениями.

Основные действия:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (постановка системного события в очередь + необязательный немедленный heartbeat)

Примечания:

- `add` ожидает полный объект cron‑задачи (та же схема, что и RPC `cron.add`).
- `update` использует `{ jobId, patch }` (для совместимости принимается `id`).

### `gateway`

Перезапуск или применение обновлений к работающему процессу Gateway (шлюз) (in‑place).

Основные действия:

- `restart` (авторизует + отправляет `SIGUSR1` для перезапуска в процессе; `openclaw gateway` — перезапуск in‑place)
- `config.get` / `config.schema`
- `config.apply` (валидация + запись конфига + перезапуск + пробуждение)
- `config.patch` (слияние частичного обновления + перезапуск + пробуждение)
- `update.run` (запуск обновления + перезапуск + пробуждение)

Примечания:

- Используйте `delayMs` (по умолчанию 2000), чтобы избежать прерывания выполняемого ответа.
- `restart` по умолчанию отключён; включите через `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Список сеансов, просмотр истории транскрипта или отправка в другой сеанс.

Основные параметры:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = нет)
- `sessions_history`: `sessionKey` (или `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (или `sessionId`), `message`, `timeoutSeconds?` (0 = fire‑and‑forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (по умолчанию текущий; принимает `sessionId`), `model?` (`default` очищает переопределение)

Примечания:

- `main` — канонический ключ прямого чата; глобальные/неизвестные скрыты.
- `messageLimit > 0` получает последние N сообщений на сеанс (сообщения инструментов отфильтрованы).
- `sessions_send` ожидает финального завершения при `timeoutSeconds > 0`.
- Доставка/анонс происходит после завершения и best‑effort; `status: "ok"` подтверждает завершение запуска агента, а не факт доставки анонса.
- `sessions_spawn` запускает под‑агента и публикует ответ‑анонс обратно в запрашивающий чат.
- `sessions_spawn` неблокирующий и сразу возвращает `status: "accepted"`.
- `sessions_send` выполняет ответный ping‑pong (ответьте `REPLY_SKIP` для остановки; макс. число ходов через `session.agentToAgent.maxPingPongTurns`, 0–5).
- После ping‑pong целевой агент выполняет **шаг анонса**; ответьте `ANNOUNCE_SKIP`, чтобы подавить анонс.

### `agents_list`

Список id агентов, на которые текущий сеанс может нацеливаться с помощью `sessions_spawn`.

Примечания:

- Результат ограничен списками разрешённых для агента (`agents.list[].subagents.allowAgents`).
- Когда настроен `["*"]`, инструмент включает всех настроенных агентов и помечает `allowAny: true`.

## Параметры (общие)

Инструменты на базе Gateway (шлюз) (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (по умолчанию `ws://127.0.0.1:18789`)
- `gatewayToken` (если включена аутентификация)
- `timeoutMs`

Примечание: когда задан `gatewayUrl`, явно указывайте `gatewayToken`. Инструменты не наследуют конфиг
или учётные данные окружения для переопределений, и отсутствие явных учётных данных считается ошибкой.

Инструмент браузера:

- `profile` (необязательно; по умолчанию `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (необязательно; закрепить конкретный id/имя узла)

## Рекомендуемые потоки агента

Автоматизация браузера:

1. `browser` → `status` / `start`
2. `snapshot` (ai или aria)
3. `act` (click/type/press)
4. `screenshot`, если нужна визуальная проверка

Рендер Canvas:

1. `canvas` → `present`
2. `a2ui_push` (необязательно)
3. `snapshot`

Нацеливание на узел:

1. `nodes` → `status`
2. `describe` на выбранном узле
3. `notify` / `run` / `camera_snap` / `screen_record`

## Безопасность

- Избегайте прямого `system.run`; используйте `nodes` → `run` только с явного согласия пользователя.
- Соблюдайте согласие пользователя на захват камеры/экрана.
- Используйте `status/describe`, чтобы убедиться в наличии разрешений перед вызовом медиакоманд.

## Как инструменты представляются агенту

Инструменты предоставляются по двум параллельным каналам:

1. **Текст системного промпта**: человекочитаемый список + рекомендации.
2. **Схема инструментов**: структурированные определения функций, отправляемые в API модели.

Это означает, что агент видит и «какие инструменты существуют», и «как их вызывать». Если инструмент
не появляется ни в системном промпте, ни в схеме, модель не может его вызвать.
