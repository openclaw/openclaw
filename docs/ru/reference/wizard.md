---
summary: "Полная справка по мастеру онбординга CLI: каждый шаг, флаг и поле конфигурации"
read_when:
  - Поиск конкретного шага или флага мастера
  - Автоматизация онбординга в неинтерактивном режиме
  - Отладка поведения мастера
title: "Справочник мастера онбординга"
sidebarTitle: "Wizard Reference"
---

# Справочник мастера онбординга

Это полный справочник по CLI‑мастеру `openclaw onboard`.
Для обзора высокого уровня см. [Мастер онбординга](/start/wizard).

## Детали потока (локальный режим)

<Steps>
  <Step title="Existing config detection">
    - Если существует `~/.openclaw/openclaw.json`, предлагается выбрать **Сохранить / Изменить / Сбросить**.
    - Повторный запуск мастера **не** очищает ничего, если вы явно не выберете **Сброс**
      (или не передадите `--reset`).
    - Если конфиг недействителен или содержит устаревшие ключи, мастер останавливается и просит
      запустить `openclaw doctor` перед продолжением.
    - Сброс использует `trash` (никогда `rm`) и предлагает области:
      - Только конфиг
      - Конфиг + учётные данные + сеансы
      - Полный сброс (также удаляет рабочее пространство)  
</Step>
  <Step title="Model/Auth">
    - **Ключ API Anthropic (рекомендуется)**: использует `ANTHROPIC_API_KEY`, если он есть, или запрашивает ключ, затем сохраняет его для использования демоном.
    - **Anthropic OAuth (Claude Code CLI)**: на macOS мастер проверяет элемент Keychain «Claude Code-credentials» (выберите «Always Allow», чтобы запуски launchd не блокировались); на Linux/Windows повторно использует `~/.claude/.credentials.json`, если он есть.
    - **Токен Anthropic (вставьте setup-token)**: запустите `claude setup-token` на любой машине, затем вставьте токен (его можно назвать; пусто = по умолчанию).
    - **Подписка OpenAI Code (Codex) (Codex CLI)**: если существует `~/.codex/auth.json`, мастер может повторно использовать его.
    - **Подписка OpenAI Code (Codex) (OAuth)**: поток через браузер; вставьте `code#state`.
      - Устанавливает `agents.defaults.model` в `openai-codex/gpt-5.2`, когда модель не задана или `openai/*`.
    - **Ключ API OpenAI**: использует `OPENAI_API_KEY`, если он есть, или запрашивает ключ, затем сохраняет его в `~/.openclaw/.env`, чтобы launchd мог его прочитать.
    - **Ключ API xAI (Grok)**: запрашивает `XAI_API_KEY` и настраивает xAI как провайдера модели.
    - **OpenCode Zen (мульти‑модельный прокси)**: запрашивает `OPENCODE_API_KEY` (или `OPENCODE_ZEN_API_KEY`, получите его на https://opencode.ai/auth).
    - **Ключ API**: сохраняет ключ за вас.
    - **Vercel AI Gateway (мульти‑модельный прокси)**: запрашивает `AI_GATEWAY_API_KEY`.
    - Подробнее: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: запрашивает Account ID, Gateway ID и `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Подробнее: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: конфиг записывается автоматически.
    - Подробнее: [MiniMax](/providers/minimax)
    - **Synthetic (совместимый с Anthropic)**: запрашивает `SYNTHETIC_API_KEY`.
    - Подробнее: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: конфиг записывается автоматически.
    - **Kimi Coding**: конфиг записывается автоматически.
    - Подробнее: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Пропустить**: аутентификация пока не настраивается.
    - Выберите модель по умолчанию из обнаруженных вариантов (или введите провайдер/модель вручную).
    - Мастер выполняет проверку модели и предупреждает, если настроенная модель неизвестна или отсутствует аутентификация.
    - Учётные данные OAuth хранятся в `~/.openclaw/credentials/oauth.json`; профили аутентификации — в `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (ключи API + OAuth).
    - Подробнее: [/concepts/oauth](/concepts/oauth)    
<Note>
    Совет для headless/серверов: завершите OAuth на машине с браузером, затем скопируйте
    `~/.openclaw/credentials/oauth.json` (или `$OPENCLAW_STATE_DIR/credentials/oauth.json`) на
    хост шлюза Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - По умолчанию `~/.openclaw/workspace` (настраивается).
    - Создаёт файлы рабочего пространства, необходимые для ритуала инициализации агента.
    - Полная структура рабочего пространства + руководство по резервному копированию: [Рабочее пространство агента](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Порт, привязка, режим аутентификации, экспонирование через Tailscale.
    - Рекомендация по аутентификации: сохраняйте **Token** даже для loopback, чтобы локальные WS‑клиенты должны были проходить аутентификацию.
    - Отключайте аутентификацию только если вы полностью доверяете каждому локальному процессу.
    - Привязки не к loopback всё равно требуют аутентификации.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): необязательный вход по QR.
    - [Telegram](/channels/telegram): токен бота.
    - [Discord](/channels/discord): токен бота.
    - [Google Chat](/channels/googlechat): JSON сервисного аккаунта + audience вебхука.
    - [Mattermost](/channels/mattermost) (плагин): токен бота + базовый URL.
    - [Signal](/channels/signal): необязательная установка `signal-cli` + настройка аккаунта.
    - [BlueBubbles](/channels/bluebubbles): **рекомендуется для iMessage**; URL сервера + пароль + вебхук.
    - [iMessage](/channels/imessage): устаревший путь CLI `imsg` + доступ к БД.
    - Безопасность личных сообщений: по умолчанию — сопряжение. Первое личное сообщение отправляет код; подтвердите через `openclaw pairing approve <channel><code>` или используйте списки разрешённых.
  </Step><code>` или используйте списки разрешённых.
  </Step>
  <Step title="Установка демона">
    - macOS: LaunchAgent
      - Требуется активная пользовательская сессия; для headless используйте пользовательский LaunchDaemon (не поставляется).
    - Linux (и Windows через WSL2): пользовательский unit systemd
      - Мастер пытается включить lingering через `loginctl enable-linger <user>`, чтобы Gateway оставался запущенным после выхода из системы.
      - Может запросить sudo (записывает `/var/lib/systemd/linger`); сначала пробует без sudo.
    - **Выбор рантайма:** Node (рекомендуется; обязателен для WhatsApp/Telegram). Bun **не рекомендуется**.
  </Step>
  <Step title="Проверка работоспособности">
    - Запускает Gateway (при необходимости) и выполняет `openclaw health`.
    - Совет: `openclaw status --deep` добавляет пробы здоровья Gateway в вывод статуса (требуется доступный Gateway).
  </Step>
  <Step title="Skills (рекомендуется)">
    - Считывает доступные Skills и проверяет требования.
    - Позволяет выбрать менеджер узлов: **npm / pnpm** (bun не рекомендуется).
    - Устанавливает необязательные зависимости (некоторые используют Homebrew на macOS).
  </Step>
  <Step title="Завершение">
    - Сводка + дальнейшие шаги, включая приложения для iOS/Android/macOS для дополнительных возможностей.
  </Step>
</Steps>

<Note>
Если графический интерфейс не обнаружен, мастер выводит инструкции по пробросу портов SSH для Control UI вместо открытия браузера.
Если ассеты Control UI отсутствуют, мастер пытается их собрать; запасной вариант — `pnpm ui:build` (автоматически устанавливает зависимости UI).
</Note>

## Неинтерактивный режим

Используйте `--non-interactive` для автоматизации или скриптов онбординга:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Добавьте `--json` для машиночитаемой сводки.

<Note>
`--json` **не** подразумевает неинтерактивный режим. Для скриптов используйте `--non-interactive` (и `--workspace`).
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Добавить агента (неинтерактивно)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## RPC мастера Gateway

Gateway (шлюз) предоставляет поток мастера через RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Клиенты (приложение для macOS, Control UI) могут отрисовывать шаги без повторной реализации логики онбординга.

## Настройка Signal (signal-cli)

Мастер может установить `signal-cli` из релизов GitHub:

- Загружает соответствующий asset релиза.
- Сохраняет его в `~/.openclaw/tools/signal-cli/<version>/`.
- Записывает `channels.signal.cliPath` в ваш конфиг.

Примечания:

- Сборки JVM требуют **Java 21**.
- Нативные сборки используются, когда доступны.
- Windows использует WSL2; установка signal-cli следует потоку Linux внутри WSL.

## Что записывает мастер

Типичные поля в `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (если выбран Minimax)
- `gateway.*` (режим, привязка, аутентификация, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Списки разрешённых каналов (Slack/Discord/Matrix/Microsoft Teams), если вы соглашаетесь на них во время подсказок (имена по возможности разрешаются в ID).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` записывает `agents.list[]` и необязательный `bindings`.

Учётные данные WhatsApp помещаются в `~/.openclaw/credentials/whatsapp/<accountId>/`.
Сеансы хранятся в `~/.openclaw/agents/<agentId>/sessions/`.

Некоторые каналы поставляются в виде плагинов. Когда вы выбираете такой канал во время онбординга, мастер
предложит установить его (npm или локальный путь) перед тем, как его можно будет настроить.

## Связанная документация

- Обзор мастера: [Мастер онбординга](/start/wizard)
- Онбординг приложения для macOS: [Онбординг](/start/onboarding)
- Справочник конфига: [Конфигурация Gateway](/gateway/configuration)
- Провайдеры: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (устаревший)
- Skills: [Skills](/tools/skills), [Конфиг Skills](/tools/skills-config)
