---
summary: "Справочник CLI OpenClaw для команд, подкоманд и параметров `openclaw`"
read_when:
  - Добавление или изменение команд или параметров CLI
  - Документирование новых поверхностей команд
title: "Справочник CLI"
---

# Справочник CLI

Эта страница описывает текущее поведение CLI. Если команды меняются, обновляйте этот документ.

## Страницы команд

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (команды плагинов)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (плагин; если установлен)

## Глобальные флаги

- `--dev`: изолировать состояние под `~/.openclaw-dev` и сместить порты по умолчанию.
- `--profile <name>`: изолировать состояние под `~/.openclaw-<name>`.
- `--no-color`: отключить ANSI-цвета.
- `--update`: сокращение для `openclaw update` (только для установок из исходников).
- `-V`, `--version`, `-v`: вывести версию и выйти.

## Оформление вывода

- ANSI-цвета и индикаторы прогресса отображаются только в TTY-сеансах.
- Гиперссылки OSC-8 отображаются как кликабельные ссылки в поддерживаемых терминалах; в противном случае используется обычный URL.
- `--json` (и `--plain` там, где поддерживается) отключает оформление для «чистого» вывода.
- `--no-color` отключает ANSI-оформление; `NO_COLOR=1` также учитывается.
- Длительные команды показывают индикатор прогресса (OSC 9;4 при поддержке).

## Цветовая палитра

OpenClaw использует палитру «lobster» для вывода CLI.

- `accent` (#FF5A2D): заголовки, метки, основные акценты.
- `accentBright` (#FF7A3D): имена команд, акценты.
- `accentDim` (#D14A22): вторичный акцентный текст.
- `info` (#FF8A5B): информационные значения.
- `success` (#2FBF71): состояния успеха.
- `warn` (#FFB020): предупреждения, резервные варианты, внимание.
- `error` (#E23D2D): ошибки, сбои.
- `muted` (#8B7F77): деакцентирование, метаданные.

Единый источник палитры: `src/terminal/palette.ts` (он же «lobster seam»).

## Дерево команд

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Примечание: плагины могут добавлять дополнительные команды верхнего уровня (например, `openclaw voicecall`).

## Безопасность

- `openclaw security audit` — аудит конфига и локального состояния на типичные уязвимые настройки.
- `openclaw security audit --deep` — best-effort живой зонд Gateway (шлюз).
- `openclaw security audit --fix` — ужесточение безопасных значений по умолчанию и chmod состояния/конфига.

## Плагины

Управление расширениями и их конфигурацией:

- `openclaw plugins list` — обнаружение плагинов (используйте `--json` для машинного вывода).
- `openclaw plugins info <id>` — показать сведения о плагине.
- `openclaw plugins install <path|.tgz|npm-spec>` — установить плагин (или добавить путь плагина в `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — переключить `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — отчёт об ошибках загрузки плагинов.

Большинство изменений плагинов требуют перезапуска Gateway (шлюз). См. [/plugin](/tools/plugin).

## Память

Векторный поиск по `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — показать статистику индекса.
- `openclaw memory index` — переиндексировать файлы памяти.
- `openclaw memory search "<query>"` — семантический поиск по памяти.

## Слэш-команды чата

Сообщения чата поддерживают команды `/...` (текстовые и нативные). См. [/tools/slash-commands](/tools/slash-commands).

Выделить:

- `/status` для быстрой диагностики.
- `/config` для сохранённых изменений конфига.
- `/debug` для временных переопределений конфига во время выполнения (в памяти, не на диске; требуется `commands.debug: true`).

## Настройка и онбординг

### `setup`

Инициализация конфига и рабочего пространства.

Параметры:

- `--workspace <dir>`: путь к рабочему пространству агента (по умолчанию `~/.openclaw/workspace`).
- `--wizard`: запустить мастер онбординга.
- `--non-interactive`: запустить мастер без запросов.
- `--mode <local|remote>`: режим мастера.
- `--remote-url <url>`: URL удалённого Gateway (шлюз).
- `--remote-token <token>`: токен удалённого Gateway (шлюз).

Мастер запускается автоматически при наличии любого флага мастера (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Интерактивный мастер настройки Gateway (шлюз), рабочего пространства и skills.

Параметры:

- `--workspace <dir>`
- `--reset` (сброс конфига + учётных данных + сеансов + рабочего пространства перед мастером)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual — псевдоним для advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (неинтерактивный; используется с `--auth-choice token`)
- `--token <token>` (неинтерактивный; используется с `--auth-choice token`)
- `--token-profile-id <id>` (неинтерактивный; по умолчанию: `<provider>:manual`)
- `--token-expires-in <duration>` (неинтерактивный; например, `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (псевдоним: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm рекомендуется; bun не рекомендуется для runtime Gateway)
- `--json`

### `configure`

Интерактивный мастер конфигурации (модели, каналы, skills, Gateway).

### `config`

Неинтерактивные помощники конфига (get/set/unset). Запуск `openclaw config` без
подкоманды запускает мастер.

Подкоманды:

- `config get <path>`: вывести значение конфига (путь dot/bracket).
- `config set <path> <value>`: установить значение (JSON5 или строка).
- `config unset <path>`: удалить значение.

### `doctor`

Проверки здоровья + быстрые исправления (конфиг + Gateway + устаревшие сервисы).

Параметры:

- `--no-workspace-suggestions`: отключить подсказки памяти рабочего пространства.
- `--yes`: принять значения по умолчанию без запросов (headless).
- `--non-interactive`: пропустить запросы; применить только безопасные миграции.
- `--deep`: просканировать системные сервисы на наличие дополнительных установок Gateway.

## Помощники каналов

### `channels`

Управление учётными записями каналов чата (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (плагин)/Signal/iMessage/MS Teams).

Подкоманды:

- `channels list`: показать настроенные каналы и профили аутентификации.
- `channels status`: проверить доступность Gateway и здоровье каналов (`--probe` выполняет дополнительные проверки; используйте `openclaw health` или `openclaw status --deep` для зондирования здоровья Gateway).
- Совет: `channels status` выводит предупреждения с предлагаемыми исправлениями, когда может обнаружить типичные ошибки конфигурации (затем указывает на `openclaw doctor`).
- `channels logs`: показать последние логи каналов из файла логов Gateway.
- `channels add`: мастер настройки в стиле wizard, если флаги не переданы; флаги переключают в неинтерактивный режим.
- `channels remove`: по умолчанию отключено; передайте `--delete`, чтобы удалить записи конфига без запросов.
- `channels login`: интерактивный вход в канал (только WhatsApp Web).
- `channels logout`: выход из сеанса канала (если поддерживается).

Общие параметры:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: идентификатор учётной записи канала (по умолчанию `default`)
- `--name <label>`: отображаемое имя учётной записи

Параметры `channels login`:

- `--channel <channel>` (по умолчанию `whatsapp`; поддерживает `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Параметры `channels logout`:

- `--channel <channel>` (по умолчанию `whatsapp`)
- `--account <id>`

Параметры `channels list`:

- `--no-usage`: пропустить снимки использования/квот провайдера модели (только OAuth/API).
- `--json`: вывод в формате JSON (включает использование, если не задан `--no-usage`).

Параметры `channels logs`:

- `--channel <name|all>` (по умолчанию `all`)
- `--lines <n>` (по умолчанию `200`)
- `--json`

Подробнее: [/concepts/oauth](/concepts/oauth)

Примеры:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Список и инспекция доступных skills с информацией о готовности.

Подкоманды:

- `skills list`: список skills (по умолчанию, если подкоманда не указана).
- `skills info <name>`: показать сведения об одном skill.
- `skills check`: сводка готовых и отсутствующих требований.

Параметры:

- `--eligible`: показывать только готовые skills.
- `--json`: вывод в формате JSON (без оформления).
- `-v`, `--verbose`: включить детали отсутствующих требований.

Совет: используйте `npx clawhub` для поиска, установки и синхронизации skills.

### `pairing`

Подтверждение запросов сопряжения личных сообщений (DM) между каналами.

Подкоманды:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Настройка и запуск хука Gmail Pub/Sub. [/automation/gmail-pubsub](/automation/gmail-pubsub).

Подкоманды:

- `webhooks gmail setup` (требуется `--account <email>`; поддерживает `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (переопределения во время выполнения для тех же флагов)

### `dns setup`

DNS‑помощник для широкозонного discovery (CoreDNS + Tailscale). См. [/gateway/discovery](/gateway/discovery).

Параметры:

- `--apply`: установить/обновить конфиг CoreDNS (требуется sudo; только macOS).

## Сообщения и агент

### `message`

Единый исходящий обмен сообщениями и действия каналов.

См.: [/cli/message](/cli/message)

Подкоманды:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Примеры:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Выполнить один шаг агента через Gateway (шлюз) (или встроенный `--local`).

Требуется:

- `--message <text>`

Параметры:

- `--to <dest>` (для ключа сеанса и необязательной доставки)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (только модели GPT-5.2 + Codex)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Управление изолированными агентами (рабочие пространства + аутентификация + маршрутизация).

#### `agents list`

Список настроенных агентов.

Параметры:

- `--json`
- `--bindings`

#### `agents add [name]`

Добавить новый изолированный агент. Запускает мастер с подсказками, если не переданы флаги (или `--non-interactive`); в неинтерактивном режиме требуется `--workspace`.

Параметры:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (повторяемый)
- `--non-interactive`
- `--json`

Спецификации привязки используют `channel[:accountId]`. Если `accountId` не указан для WhatsApp, используется идентификатор учётной записи по умолчанию.

#### `agents delete <id>`

Удалить агента и очистить его рабочее пространство и состояние.

Параметры:

- `--force`
- `--json`

### `acp`

Запуск моста ACP, соединяющего IDE с Gateway.

См. [`acp`](/cli/acp) для полного списка параметров и примеров.

### `status`

Показать здоровье связанных сеансов и недавних получателей.

Параметры:

- `--json`
- `--all` (полная диагностика; только чтение, пригодно для вставки)
- `--deep` (зондирование каналов)
- `--usage` (показать использование/квоты провайдера модели)
- `--timeout <ms>`
- `--verbose`
- `--debug` (псевдоним для `--verbose`)

Примечания:

- Обзор включает состояние Gateway и службы хоста узла, когда доступно.

### Отслеживание использования

OpenClaw может отображать использование/квоты провайдеров при наличии учётных данных OAuth/API.

Поверхности:

- `/status` (добавляет краткую строку использования провайдера, когда доступно)
- `openclaw status --usage` (печатает полный разбор по провайдерам)
- строка меню macOS (раздел Usage в Context)

Примечания:

- Данные поступают напрямую из эндпоинтов использования провайдеров (без оценок).
- Провайдеры: Anthropic, GitHub Copilot, OpenAI Codex OAuth, а также Gemini CLI/Antigravity при включённых плагинах провайдеров.
- Если подходящих учётных данных нет, использование скрыто.
- Подробности: см. [Usage tracking](/concepts/usage-tracking).

### `health`

Получить состояние здоровья от запущенного Gateway.

Параметры:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Список сохранённых сеансов разговоров.

Параметры:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Сброс / Удаление

### `reset`

Сброс локального конфига/состояния (CLI остаётся установленным).

Параметры:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Примечания:

- `--non-interactive` требует `--scope` и `--yes`.

### `uninstall`

Удалить службу Gateway и локальные данные (CLI остаётся).

Параметры:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Примечания:

- `--non-interactive` требует `--yes` и явных областей (или `--all`).

## Gateway

### `gateway`

Запуск WebSocket Gateway.

Параметры:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (сброс dev‑конфига + учётных данных + сеансов + рабочего пространства)
- `--force` (завершить существующий слушатель на порту)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (псевдоним для `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Управление службой Gateway (launchd/systemd/schtasks).

Подкоманды:

- `gateway status` (по умолчанию зондирует RPC шлюза Gateway)
- `gateway install` (установка службы)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Примечания:

- `gateway status` по умолчанию зондирует RPC Gateway, используя разрешённый порт/конфиг службы (переопределяется `--url/--token/--password`).
- `gateway status` поддерживает `--no-probe`, `--deep` и `--json` для скриптов.
- `gateway status` также выявляет устаревшие или дополнительные службы Gateway, когда может их обнаружить (`--deep` добавляет системные сканирования). Службы OpenClaw с именем профиля считаются первоклассными и не помечаются как «extra».
- `gateway status` выводит, какой путь конфига использует CLI по сравнению с тем, какой конфиг, вероятно, использует служба (env службы), а также разрешённый URL зондирования.
- `gateway install|uninstall|start|stop|restart` поддерживает `--json` для скриптов (вывод по умолчанию остаётся удобочитаемым).
- `gateway install` по умолчанию использует runtime Node; bun **не рекомендуется** (ошибки WhatsApp/Telegram).
- Параметры `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Просмотр файловых логов Gateway через RPC.

Примечания:

- В TTY-сеансах отображается цветной структурированный вид; вне TTY используется простой текст.
- `--json` выводит построчный JSON (одно событие лога на строку).

Примеры:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Помощники CLI Gateway (используйте `--url`, `--token`, `--password`, `--timeout`, `--expect-final` для RPC‑подкоманд).
При передаче `--url` CLI не применяет автоматически конфиг или учётные данные из окружения.
Явно укажите `--token` или `--password`. Отсутствие явных учётных данных — ошибка.

Подкоманды:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Общие RPC:

- `config.apply` (проверить + записать конфиг + перезапуск + пробуждение)
- `config.patch` (объединить частичное обновление + перезапуск + пробуждение)
- `update.run` (выполнить обновление + перезапуск + пробуждение)

Совет: при прямом вызове `config.set`/`config.apply`/`config.patch` передавайте `baseHash` из
`config.get`, если конфиг уже существует.

## Модели

См. [/concepts/models](/concepts/models) для поведения fallback и стратегии сканирования.

Предпочтительная аутентификация Anthropic (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (корень)

`openclaw models` является псевдонимом для `models status`.

Параметры корня:

- `--status-json` (псевдоним для `models status --json`)
- `--status-plain` (псевдоним для `models status --plain`)

### `models list`

Параметры:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Параметры:

- `--json`
- `--plain`
- `--check` (выход 1=истёк/отсутствует, 2=истекает)
- `--probe` (живой зонд настроенных профилей аутентификации)
- `--probe-provider <name>`
- `--probe-profile <id>` (повторяемый или через запятую)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Всегда включает обзор аутентификации и статус истечения OAuth для профилей в хранилище аутентификации.
`--probe` выполняет живые запросы (может расходовать токены и вызывать ограничения).

### `models set <model>`

Установить `agents.defaults.model.primary`.

### `models set-image <model>`

Установить `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Параметры:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Параметры:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Параметры:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Параметры:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Параметры:

- `add`: интерактивный помощник аутентификации
- `setup-token`: `--provider <name>` (по умолчанию `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Параметры:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Система

### `system event`

Поставить системное событие в очередь и при необходимости запустить heartbeat (RPC Gateway).

Требуется:

- `--text <text>`

Параметры:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Управление heartbeat (RPC Gateway).

Параметры:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Список записей присутствия системы (RPC Gateway).

Параметры:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Управление запланированными заданиями (RPC Gateway). [/automation/cron-jobs](/automation/cron-jobs).

Подкоманды:

- `cron status [--json]`
- `cron list [--all] [--json]` (по умолчанию табличный вывод; используйте `--json` для raw)
- `cron add` (псевдоним: `create`; требуется `--name` и ровно одно из `--at` | `--every` | `--cron`, и ровно один payload из `--system-event` | `--message`)
- `cron edit <id>` (патч полей)
- `cron rm <id>` (псевдонимы: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Все команды `cron` принимают `--url`, `--token`, `--timeout`, `--expect-final`.

## Хост узла

`node` запускает **headless node host** или управляет им как фоновым сервисом. См. [`openclaw node`](/cli/node).

Подкоманды:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Узлы

`nodes` взаимодействует с Gateway и нацеливается на сопряжённые узлы. См. [/nodes](/nodes).

Общие параметры:

- `--url`, `--token`, `--timeout`, `--json`

Подкоманды:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (узел mac или headless node host)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (только mac)

Камера:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas и экран:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Местоположение:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Браузер

CLI управления браузером (выделенный Chrome/Brave/Edge/Chromium). См. [`openclaw browser`](/cli/browser) и [Browser tool](/tools/browser).

Общие параметры:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Управление:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Инспекция:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Действия:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Поиск по документации

### `docs [query...]`

Поиск по живому индексу документации.

## TUI

### `tui`

Открыть терминальный интерфейс, подключённый к Gateway.

Параметры:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (по умолчанию `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
