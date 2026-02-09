---
summary: "Полный справочник по потоку онбординга CLI, настройке аутентификации и моделей, выходным данным и внутренним механизмам"
read_when:
  - Вам нужно детальное описание поведения онбординга openclaw
  - Вы отлаживаете результаты онбординга или интегрируете клиенты онбординга
title: "Справочник по онбордингу CLI"
sidebarTitle: "CLI reference"
---

# Справочник по онбордингу CLI

Эта страница — полный справочник для `openclaw onboard`.
Краткое руководство см. в [Onboarding Wizard (CLI)](/start/wizard).

## Что делает мастер

Локальный режим (по умолчанию) проводит вас через:

- Настройку моделей и аутентификации (OAuth подписки OpenAI Code, ключ API Anthropic или setup-token, а также варианты MiniMax, GLM, Moonshot и AI Gateway)
- Расположение рабочего пространства и bootstrap-файлы
- Параметры Gateway (шлюз) (порт, привязка, аутентификация, Tailscale)
- Каналы и провайдеры (Telegram, WhatsApp, Discord, Google Chat, плагин Mattermost, Signal)
- Установку демона (LaunchAgent или пользовательский unit systemd)
- Проверка здоровья
- Настройку Skills

Удалённый режим настраивает эту машину для подключения к Gateway (шлюз), расположенному в другом месте.
Он не устанавливает и не изменяет ничего на удалённом хосте.

## Детали локального потока

<Steps>
  <Step title="Existing config detection">
    - Если существует `~/.openclaw/openclaw.json`, выберите «Сохранить», «Изменить» или «Сбросить».
    - Повторный запуск мастера ничего не удаляет, если вы явно не выберете «Сбросить» (или не передадите `--reset`).
    - Если конфигурация недействительна или содержит устаревшие ключи, мастер останавливается и просит запустить `openclaw doctor` перед продолжением.
    - Сброс использует `trash` и предлагает области:
      - Только конфигурация
      - Конфигурация + учётные данные + сеансы
      - Полный сброс (также удаляет рабочее пространство)  
</Step>
  <Step title="Model and auth">
    - Полная матрица вариантов приведена в разделе [Параметры аутентификации и моделей](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - По умолчанию `~/.openclaw/workspace` (настраивается).
    - Заполняет рабочее пространство файлами, необходимыми для первичного bootstrap-ритуала.
    - Структура рабочего пространства: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Запрашивает порт, привязку, режим аутентификации и экспонирование через Tailscale.
    - Рекомендуется: оставить токенную аутентификацию включённой даже для loopback, чтобы локальные WS‑клиенты обязаны были аутентифицироваться.
    - Отключайте аутентификацию только если вы полностью доверяете каждому локальному процессу.
    - Привязки не к loopback по‑прежнему требуют аутентификации.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): необязательный вход по QR
    - [Telegram](/channels/telegram): токен бота
    - [Discord](/channels/discord): токен бота
    - [Google Chat](/channels/googlechat): JSON сервисного аккаунта + audience вебхука
    - Плагин [Mattermost](/channels/mattermost): токен бота + базовый URL
    - [Signal](/channels/signal): необязательная установка `signal-cli` + настройка аккаунта
    - [BlueBubbles](/channels/bluebubbles): рекомендуется для iMessage; URL сервера + пароль + webhook
    - [iMessage](/channels/imessage): устаревший путь CLI `imsg` + доступ к БД
    - Безопасность личных сообщений: по умолчанию — сопряжение. Первое личное сообщение отправляет код; подтвердите через
      `openclaw pairing approve <channel><code>` или используйте списки разрешённых.
  </Step><code>` или используйте списки разрешённых.
  </Step>
  <Step title="Установка демона">
    - macOS: LaunchAgent
      - Требуется активная пользовательская сессия; для headless используйте кастомный LaunchDaemon (не поставляется).
    - Linux и Windows через WSL2: пользовательский unit systemd
      - Мастер пытается выполнить `loginctl enable-linger <user>`, чтобы шлюз оставался запущенным после выхода из системы.
      - Может запросить sudo (запись `/var/lib/systemd/linger`); сначала пытается без sudo.
    - Выбор рантайма: Node (рекомендуется; обязателен для WhatsApp и Telegram). Bun не рекомендуется.
  </Step>
  <Step title="Проверка работоспособности">
    - Запускает шлюз (если требуется) и выполняет `openclaw health`.
    - `openclaw status --deep` добавляет пробы здоровья шлюза в вывод статуса.
  </Step>
  <Step title="Skills">
    - Считывает доступные Skills и проверяет требования.
    - Позволяет выбрать менеджер пакетов Node: npm или pnpm (bun не рекомендуется).
    - Устанавливает необязательные зависимости (некоторые используют Homebrew на macOS).
  </Step>
  <Step title="Завершение">
    - Сводка и дальнейшие шаги, включая варианты приложений для iOS, Android и macOS.
  </Step>
</Steps>

<Note>
Если GUI не обнаружен, мастер выводит инструкции по SSH‑пробросу портов для Control UI вместо открытия браузера.
Если ассеты Control UI отсутствуют, мастер пытается собрать их; резервный вариант — `pnpm ui:build` (автоматически устанавливает зависимости UI).
</Note>

## Детали удалённого режима

Удалённый режим настраивает эту машину для подключения к шлюзу, расположенному в другом месте.

<Info>
Удалённый режим не устанавливает и не изменяет ничего на удалённом хосте.
</Info>

Что вы настраиваете:

- URL удалённого Gateway (шлюз) (`ws://...`)
- Токен, если на удалённом шлюзе требуется аутентификация (рекомендуется)

<Note>
- Если шлюз доступен только по loopback, используйте SSH‑туннель или tailnet.
- Подсказки обнаружения:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Параметры аутентификации и моделей

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Использует `ANTHROPIC_API_KEY`, если он присутствует, или запрашивает ключ, затем сохраняет его для использования демоном.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: проверяет элемент Keychain «Claude Code-credentials»
    - Linux и Windows: повторно использует `~/.claude/.credentials.json`, если он присутствует

    ```
    На macOS выберите «Always Allow», чтобы запуски через launchd не блокировались.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Запустите `claude setup-token` на любой машине, затем вставьте токен.
    Его можно назвать; пустое имя использует значение по умолчанию.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Если существует `~/.codex/auth.json`, мастер может повторно использовать его.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Поток через браузер; вставьте `code#state`.

    ```
    Устанавливает `agents.defaults.model` в `openai-codex/gpt-5.3-codex`, когда модель не задана или `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Использует `OPENAI_API_KEY`, если он присутствует, или запрашивает ключ, затем сохраняет его в
    `~/.openclaw/.env`, чтобы launchd мог его читать.

    ```
    Устанавливает `agents.defaults.model` в `openai/gpt-5.1-codex`, когда модель не задана, `openai/*` или `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Запрашивает `XAI_API_KEY` и настраивает xAI как провайдера моделей.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Запрашивает `OPENCODE_API_KEY` (или `OPENCODE_ZEN_API_KEY`).
    URL настройки: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Сохраняет ключ за вас.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Запрашивает `AI_GATEWAY_API_KEY`.
    Подробнее: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Запрашивает ID аккаунта, ID шлюза и `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Подробнее: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Конфигурация записывается автоматически.
    Подробнее: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Запрашивает `SYNTHETIC_API_KEY`.
    Подробнее: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Конфигурации Moonshot (Kimi K2) и Kimi Coding записываются автоматически.
    Подробнее: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Оставляет аутентификацию ненастроенной.
  </Accordion>
</AccordionGroup>

Поведение моделей:

- Выбор модели по умолчанию из обнаруженных вариантов или ручной ввод провайдера и модели.
- Мастер выполняет проверку модели и предупреждает, если настроенная модель неизвестна или отсутствует аутентификация.

Пути к учётным данным и профилям:

- Учётные данные OAuth: `~/.openclaw/credentials/oauth.json`
- Профили аутентификации (ключи API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Совет для headless и серверов: завершите OAuth на машине с браузером, затем скопируйте
`~/.openclaw/credentials/oauth.json` (или `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
на хост шлюза Gateway.
</Note>

## Выходные данные и внутренние механизмы

Типичные поля в `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (если выбран Minimax)
- `gateway.*` (режим, привязка, аутентификация, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Списки разрешённых каналов (Slack, Discord, Matrix, Microsoft Teams) при выборе во время подсказок (имена по возможности разрешаются в ID)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` записывает `agents.list[]` и необязательный `bindings`.

Учётные данные WhatsApp размещаются в `~/.openclaw/credentials/whatsapp/<accountId>/`.
Сеансы хранятся в `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Некоторые каналы поставляются как плагины. При выборе во время онбординга мастер
предлагает установить плагин (npm или локальный путь) перед настройкой канала.
</Note>

RPC мастера шлюза Gateway:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Клиенты (приложение для macOS и Control UI) могут отрисовывать шаги без повторной реализации логики онбординга.

Поведение настройки Signal:

- Загружает соответствующий релиз‑ассет
- Сохраняет его в `~/.openclaw/tools/signal-cli/<version>/`
- Записывает `channels.signal.cliPath` в конфиг
- Сборки JVM требуют Java 21
- Нативные сборки используются при наличии
- Windows использует WSL2 и следует Linux‑потоку signal-cli внутри WSL

## Связанная документация

- Хаб онбординга: [Onboarding Wizard (CLI)](/start/wizard)
- Автоматизация и скрипты: [CLI Automation](/start/wizard-cli-automation)
- Справочник команд: [`openclaw onboard`](/cli/onboard)
