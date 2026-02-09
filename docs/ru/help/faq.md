---
summary: "Часто задаваемые вопросы по настройке, конфигурации и использованию OpenClaw"
title: "FAQ"
---

# FAQ

Короткие ответы и более глубокое устранение неполадок для реальных сценариев (локальная разработка, VPS, мультиагентные конфигурации, OAuth/API‑ключи, фейловер моделей). Для диагностики во время выполнения см. [Устранение неполадок](/gateway/troubleshooting). Полный справочник по конфигурации см. в [Конфигурация](/gateway/configuration).

## Содержание

- [Быстрый старт и первичная настройка]
  - [Я застрял — какой самый быстрый способ выбраться?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Какой рекомендуемый способ установки и настройки OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Как открыть панель управления после онбординга?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Как аутентифицировать панель управления (токен) на localhost и удалённо?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Какое окружение выполнения требуется?](#what-runtime-do-i-need)
  - [Работает ли это на Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Есть ли советы по установке на Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Застряло на «wake up my friend» / онбординг не запускается. Что делать?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Можно ли перенести установку на новую машину (Mac mini) без повторного онбординга?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Где посмотреть, что нового в последней версии?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Я не могу открыть docs.openclaw.ai (ошибка SSL). Что делать?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [В чём разница между stable и beta?](#whats-the-difference-between-stable-and-beta)
  - [Как установить beta‑версию и чем beta отличается от dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Как попробовать самые свежие изменения?](#how-do-i-try-the-latest-bits)
  - [Сколько обычно занимает установка и онбординг?](#how-long-does-install-and-onboarding-usually-take)
  - [Установщик завис? Как получить больше информации?](#installer-stuck-how-do-i-get-more-feedback)
  - [В Windows при установке пишет git not found или openclaw не распознан](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Документация не ответила на мой вопрос — как получить лучший ответ?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Как установить OpenClaw на Linux?](#how-do-i-install-openclaw-on-linux)
  - [Как установить OpenClaw на VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Где находятся руководства по установке в облаке/VPS?](#where-are-the-cloudvps-install-guides)
  - [Можно ли попросить OpenClaw обновить себя?](#can-i-ask-openclaw-to-update-itself)
  - [Что на самом деле делает мастер онбординга?](#what-does-the-onboarding-wizard-actually-do)
  - [Нужна ли подписка Claude или OpenAI для работы?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Можно ли использовать подписку Claude Max без API‑ключа](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Как работает аутентификация Anthropic «setup-token»?](#how-does-anthropic-setuptoken-auth-work)
  - [Где взять setup-token Anthropic?](#where-do-i-find-an-anthropic-setuptoken)
  - [Поддерживается ли аутентификация по подписке Claude (Claude Pro или Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Почему я вижу `HTTP 429: rate_limit_error` от Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Поддерживается ли AWS Bedrock?](#is-aws-bedrock-supported)
  - [Как работает аутентификация Codex?](#how-does-codex-auth-work)
  - [Поддерживается ли аутентификация по подписке OpenAI (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Как настроить Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Подходит ли локальная модель для повседневных чатов?](#is-a-local-model-ok-for-casual-chats)
  - [Как удержать трафик к хостируемым моделям в определённом регионе?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Обязательно ли покупать Mac mini для установки?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Нужен ли Mac mini для поддержки iMessage?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Если я куплю Mac mini для OpenClaw, смогу ли подключить его к MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Можно ли использовать Bun?](#can-i-use-bun)
  - [Telegram: что указывать в `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Могут ли несколько людей использовать один номер WhatsApp с разными инстансами OpenClaw?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Можно ли запустить «быстрый чат»‑агента и «Opus для кода»‑агента?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Работает ли Homebrew на Linux?](#does-homebrew-work-on-linux)
  - [В чём разница между hackable (git) установкой и npm‑установкой?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Можно ли позже переключаться между npm и git‑установкой?](#can-i-switch-between-npm-and-git-installs-later)
  - [Где лучше запускать Gateway — на ноутбуке или на VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Насколько важно запускать OpenClaw на выделенной машине?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Каковы минимальные требования к VPS и рекомендуемая ОС?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Можно ли запустить OpenClaw в VM и каковы требования?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Что такое OpenClaw?](#what-is-openclaw)
  - [Что такое OpenClaw в одном абзаце?](#what-is-openclaw-in-one-paragraph)
  - [В чём ценностное предложение?](#whats-the-value-proposition)
  - [Я только что установил — с чего начать?](#i-just-set-it-up-what-should-i-do-first)
  - [Пять самых распространённых повседневных сценариев использования OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Может ли OpenClaw помочь с лидогенерацией, рекламой и блогами для SaaS?](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Каковы преимущества по сравнению с Claude Code для веб‑разработки?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills и автоматизация](#skills-and-automation)
  - [Как настраивать skills, не «загрязняя» репозиторий?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Можно ли загружать skills из пользовательской папки?](#can-i-load-skills-from-a-custom-folder)
  - [Как использовать разные модели для разных задач?](#how-can-i-use-different-models-for-different-tasks)
  - [Бот «зависает» при тяжёлой работе. Как это вынести?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron или напоминания не срабатывают. Что проверить?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Как установить skills на Linux?](#how-do-i-install-skills-on-linux)
  - [Может ли OpenClaw выполнять задачи по расписанию или непрерывно в фоне?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Можно ли запускать Apple macOS‑only skills из Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Есть ли интеграция с Notion или HeyGen?](#do-you-have-a-notion-or-heygen-integration)
  - [Как установить расширение Chrome для перехвата браузера?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing и память](#sandboxing-and-memory)
  - [Есть ли отдельная документация по sandboxing?](#is-there-a-dedicated-sandboxing-doc)
  - [Как примонтировать папку хоста в sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Как работает память?](#how-does-memory-work)
  - [Память постоянно забывает. Как сделать, чтобы сохранялось?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Хранится ли память вечно? Какие ограничения?](#does-memory-persist-forever-what-are-the-limits)
  - [Требуется ли API‑ключ OpenAI для семантического поиска по памяти?](#does-semantic-memory-search-require-an-openai-api-key)
- [Где что хранится на диске](#where-things-live-on-disk)
  - [Все ли данные OpenClaw сохраняются локально?](#is-all-data-used-with-openclaw-saved-locally)
  - [Где OpenClaw хранит свои данные?](#where-does-openclaw-store-its-data)
  - [Где должны лежать AGENTS.md / SOUL.md / USER.md / MEMORY.md?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Какая стратегия резервного копирования рекомендуется?](#whats-the-recommended-backup-strategy)
  - [Как полностью удалить OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Могут ли агенты работать вне рабочего пространства?](#can-agents-work-outside-the-workspace)
  - [Я в удалённом режиме — где хранилище сеансов?](#im-in-remote-mode-where-is-the-session-store)
- [Основы конфига](#config-basics)
  - [В каком формате это конфигурация? Где это?](#what-format-is-the-config-where-is-it)
  - [Я задал `gateway.bind: "lan"` (или `"tailnet"`), и теперь ничего не слушает / UI пишет unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Почему теперь нужен токен на localhost?](#why-do-i-need-a-token-on-localhost-now)
  - [Нужно ли перезапускать после изменения конфига?](#do-i-have-to-restart-after-changing-config)
  - [Как включить веб‑поиск (и web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply стер мой конфиг. Как восстановить и избежать этого?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Как запустить центральный Gateway со специализированными воркерами на разных устройствах?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Может ли браузер OpenClaw работать в headless‑режиме?](#can-the-openclaw-browser-run-headless)
  - [Как использовать Brave для управления браузером?](#how-do-i-use-brave-for-browser-control)
- [Удалённые Gateway и узлы](#remote-gateways-and-nodes)
  - [Как команды проходят между Telegram, Gateway и узлами?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Как агенту получить доступ к моему компьютеру, если Gateway размещён удалённо?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale подключён, но ответов нет. Что делать?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Могут ли два инстанса OpenClaw общаться друг с другом (локально + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Нужны ли отдельные VPS для нескольких агентов](#do-i-need-separate-vpses-for-multiple-agents)
  - [Есть ли преимущество у узла на личном ноутбуке по сравнению с SSH с VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Запускают ли узлы сервис Gateway?](#do-nodes-run-a-gateway-service)
  - [Есть ли API / RPC‑способ применить конфиг?](#is-there-an-api-rpc-way-to-apply-config)
  - [Какой минимальный «разумный» конфиг для первой установки?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Как настроить Tailscale на VPS и подключиться с Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Как подключить Mac‑узел к удалённому Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Устанавливать на второй ноутбук или просто добавить узел?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Переменные окружения и загрузка .env](#env-vars-and-env-loading)
  - [Как OpenClaw загружает переменные окружения?](#how-does-openclaw-load-environment-variables)
  - [«Я запустил Gateway через сервис, и переменные окружения пропали». Что делать?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Я задал `COPILOT_GITHUB_TOKEN`, но статус моделей показывает «Shell env: off». Почему?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Сеансы и несколько чатов](#sessions-and-multiple-chats)
  - [Как начать новый разговор?](#how-do-i-start-a-fresh-conversation)
  - [Сбрасываются ли сеансы автоматически, если я никогда не отправляю `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Можно ли сделать команду инстансов OpenClaw: один CEO и много агентов](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Почему контекст был обрезан посреди задачи? Как это предотвратить?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Как полностью сбросить OpenClaw, но оставить установленным?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Я получаю ошибки «context too large» — как сбросить или уплотнить?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Почему я вижу «LLM request rejected: messages.N.content.X.tool_use.input: Field required»?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Почему я получаю heartbeat‑сообщения каждые 30 минут?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Нужно ли добавлять «бот‑аккаунт» в группу WhatsApp?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Как получить JID группы WhatsApp?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Почему OpenClaw не отвечает в группе?](#why-doesnt-openclaw-reply-in-a-group)
  - [Делят ли группы/треды контекст с личными сообщениями?](#do-groupsthreads-share-context-with-dms)
  - [Сколько рабочих пространств и агентов можно создать?](#how-many-workspaces-and-agents-can-i-create)
  - [Можно ли запускать несколько ботов или чатов одновременно (Slack), и как это настроить?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Модели: значения по умолчанию, выбор, алиасы, переключение](#models-defaults-selection-aliases-switching)
  - [Что такое «модель по умолчанию»?](#what-is-the-default-model)
  - [Какую модель вы рекомендуете?](#what-model-do-you-recommend)
  - [Как переключать модели, не стирая конфиг?](#how-do-i-switch-models-without-wiping-my-config)
  - [Можно ли использовать self‑hosted модели (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Какие модели используют OpenClaw, Flawd и Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Как переключать модели «на лету» (без перезапуска)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Можно ли использовать GPT 5.2 для повседневных задач и Codex 5.3 для кода](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Почему я вижу «Model … is not allowed», а затем нет ответа?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Почему я вижу «Unknown model: minimax/MiniMax-M2.1»?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Можно ли использовать MiniMax по умолчанию и OpenAI для сложных задач?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt — это встроенные шорткаты?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Как определить/переопределить алиасы моделей?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Как добавить модели от других провайдеров, таких как OpenRouter или Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Фейловер моделей и «All models failed»](#model-failover-and-all-models-failed)
  - [Как работает фейловер?](#how-does-failover-work)
  - [Что означает эта ошибка?](#what-does-this-error-mean)
  - [Чек‑лист исправления для `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Почему он также попробовал Google Gemini и неудачно?](#why-did-it-also-try-google-gemini-and-fail)
- [Профили аутентификации: что это и как ими управлять](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Что такое профиль аутентификации?](#what-is-an-auth-profile)
  - [Какие типичные ID профилей?](#what-are-typical-profile-ids)
  - [Можно ли контролировать, какой профиль пробуется первым?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API‑ключ: в чём разница?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: порты, «уже запущен» и удалённый режим](#gateway-ports-already-running-and-remote-mode)
  - [Какой порт использует Gateway?](#what-port-does-the-gateway-use)
  - [Почему `openclaw gateway status` пишет `Runtime: running`, но `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Почему `openclaw gateway status` показывает разные `Config (cli)` и `Config (service)`?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Что означает «another gateway instance is already listening»?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Как запустить OpenClaw в удалённом режиме (клиент подключается к удалённому Gateway)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI пишет «unauthorized» (или постоянно переподключается). Что делать?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Я задал `gateway.bind: "tailnet"`, но он не может привязаться / ничего не слушает](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Можно ли запускать несколько Gateway на одном хосте?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Что означает «invalid handshake» / код 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Логи и отладка](#logging-and-debugging)
  - [Где находятся логи?](#where-are-logs)
  - [Как запустить/остановить/перезапустить сервис Gateway?](#how-do-i-startstoprestart-the-gateway-service)
  - [Я закрыл терминал в Windows — как перезапустить OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway запущен, но ответы не приходят. Что проверить?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [«Disconnected from gateway: no reason» — что делать?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands падает с сетевыми ошибками. Что проверить?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI не показывает вывод. Что проверить?](#tui-shows-no-output-what-should-i-check)
  - [Как полностью остановить, а затем запустить Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Какой самый быстрый способ получить больше деталей при ошибке?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Медиа и вложения](#media-and-attachments)
  - [Мой skill сгенерировал изображение/PDF, но ничего не отправилось](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Безопасность и контроль доступа](#security-and-access-control)
  - [Безопасно ли открывать OpenClaw для входящих личных сообщений?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Является ли prompt injection проблемой только для публичных ботов?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Должен ли у бота быть собственный email, GitHub‑аккаунт или номер телефона](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Можно ли дать ему автономию над моими текстовыми сообщениями и безопасно ли это](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Можно ли использовать более дешёвые модели для задач персонального ассистента?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Я выполнил `/start` в Telegram, но не получил код сопряжения](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: будет ли он писать моим контактам? Как работает сопряжение?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Команды чата, прерывание задач и «он не останавливается»](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Как скрыть внутренние системные сообщения в чате](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Как остановить/отменить выполняющуюся задачу?](#how-do-i-stopcancel-a-running-task)
  - [Как отправить сообщение Discord из Telegram? («Cross-context messaging denied»)](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Почему кажется, что бот «игнорирует» быстрые подряд сообщения?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Первые 60 секунд, если что‑то сломалось

1. **Быстрый статус (первая проверка)**

   ```bash
   openclaw status
   ```

   Быстрое локальное резюме: ОС + обновления, доступность gateway/сервиса, агенты/сеансы, конфигурация провайдеров + проблемы выполнения (когда gateway доступен).

2. **Отчёт, который можно вставить (безопасен для шаринга)**

   ```bash
   openclaw status --all
   ```

   Диагностика «только чтение» с хвостом логов (токены скрыты).

3. **Состояние демона и портов**

   ```bash
   openclaw gateway status
   ```

   Показывает состояние supervisor vs доступность RPC, целевой URL проба и какой конфиг, вероятно, использовал сервис.

4. **Глубокие проверки**

   ```bash
   openclaw status --deep
   ```

   Запускает проверки здоровья gateway + пробы провайдеров (требуется доступный gateway). См. [Health](/gateway/health).

5. **Хвост последнего лога**

   ```bash
   openclaw logs --follow
   ```

   Если RPC недоступен, используйте:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Файловые логи отделены от логов сервиса; см. [Логи](/logging) и [Устранение неполадок](/gateway/troubleshooting).

6. **Запуск doctor (ремонт)**

   ```bash
   openclaw doctor
   ```

   Ремонт/миграция конфига/состояния + проверки здоровья. См. [Doctor](/gateway/doctor).

7. **Снимок Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Запрашивает у работающего gateway полный снимок (только WS). См. [Health](/gateway/health).

## Быстрый старт и первичная настройка

### Я застрял что самый быстрый способ застрять

Используйте локальный AI агент, который может **видеть вашу машину**. Это гораздо эффективнее, чем просить
в Discord, потому что большинство случаев "Я застрял" - это **проблемы локальной конфигурации или окружения**, которые
не могут проверить удаленные помощники.

- **Код Claude**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **Код OpenAI**: [https://openai.com/codex/](https://openai.com/codex/)

Эти инструменты могут читать репозиторий, выполнять команды, просматривать логи и помогать исправлять настройку на уровне машины (PATH, сервисы, права, файлы аутентификации). Дайте им **полную проверку исходного кода** через
инсталляцию с хакером (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Это устанавливает OpenClaw **из git-чекаута**, чтобы агент мог читать код и документацию и рассуждать о точной версии, которую вы используете. Вы всегда можете вернуться к стабильному позже
перезапустив программу установки без `--install-method git`.

Совет: попросите агента **планировать и курировать** исправление (шаг за шагом), а затем выполнить только
необходимые команды. Это сохраняет небольшие изменения и проще проверить.

Если вы обнаружили настоящую ошибку или исправите, пожалуйста, отправьте запрос на GitHub или отправьте PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Начать с этими командами (обмениваться результатами при запросе помощи):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Что они делают:

- `openclaw status`: быстрый снимок здоровья шлюза/агента + базовая конфигурация.
- `openclaw модели статус`: проверяет авторитет провайдера + доступность модели.
- `openclaw doctor`: проверяет и восстанавливает общие проблемы конфигурации/состояния.

Другие полезные CLI проверяет: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Цикл быстрой отладки: [Первые 60 секунд, если что-то сломало](#first-60-seconds-if-somethings-broken).
Установка документов: [Install](/install), [флаги установщика](/install/installer), [Updating](/install/updating).

### Как рекомендуется установить и установить OpenClaw

Репо рекомендует запустить с исходного кода и использовать мастера посадки:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw на борту --install-daemon
```

Мастер также может автоматически создавать пользовательские ресурсы. После посадки на борту вы обычно запускаете шлюз на порту **18789**.

Из источника (участников/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps при первом запуске
openclaw на борту
```

Если у вас еще нет глобальной установки, запустите ее через `pnpm openclaw onboard`.

### Как открыть панель после посадки

Мастер откроет ваш браузер с чистым (не-токен) URL-адресом приборной панели сразу после регистрации, а также распечатает ссылку в сводке. Держите эту вкладку открыть; если она не запускается, скопируйте или вставьте напечатанный URL на той же машине.

### Как аутентифицировать токен панели инструментов на локальном хосте против удаленного

**Локальный хост (та же машина):**

- Open `http://127.0.0.1:18789/`.
- Если запрашивает автора, вставьте токен из `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`) в настройки интерфейса управления.
- Получить его от шлюза хоста: `openclaw config get gateway.auth.token` (или генерировать один: `openclaw doctor --generate-gateway-token`).

**Не на localhost:**

- **Сервер тайлшкалы** (рекомендуется): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. Если `gateway.auth.allowTailscale` это `true`, идентификационные заголовки удовлетворяют auth (без токена).
- **Tailnet bind**: запустите `openclaw gateway --bind tailnet --token "<token>"`, откройте `http://<tailscale-ip>:18789/`, вставьте токен в настройки панели инструментов.
- **SSH туннель**: `ssh -N -L 18789:127.0.0.1:18789 user@host` затем откройте `http://127.0.0.1:18789/` и вставьте токен в настройки интерфейса управления.

Смотрите режимы привязки и детали авторизации [Dashboard](/web/dashboard) и [Web поверхности](/web).

### Что мне нужно

Узел **>= 22** требуется. Рекомендуется `pnpm`. Бун **не рекомендуется** для шлюза.

### Бежит на Raspberry Pi

Да. Шлюз легкий вес - список документов **512MB-1GB RAM**, **1 ядро**, и примерно **500MB**
дисков достаточно для личного использования, и обратите внимание, что **Raspberry Pi 4 может запустить его**.

Если вам нужны дополнительные головные уборы (бревна, медиа, другие сервисы), **2ГБ рекомендуется**, но это
не минимум жесткий.

Совет: небольшой Pi/VPS может разместить шлюз и вы можете подключить **узлы** на вашем ноутбуке/телефоне для
локального экрана/камеры/холста или выполнить команду. См. [Nodes](/nodes).

### Любые советы по установке Raspberry Pi

Короткая версия: она работает, но ожидают грубые края.

- Используйте **64-бит** ОС и держите узел >= 22.
- Предпочитайте **хакерскую (git) установку**, чтобы вы могли видеть журналы и быстро обновиться.
- Начните без каналов/навыков, а затем добавьте их по одному.
- Если вы столкнулись с странными бинарными проблемами, это обычно проблема **совместимости ARM**.

Документы: [Linux](/platforms/linux), [Install](/install).

### Это застрял на пробуждение моего друга в посадке не будет стрелять, что теперь

Этот экран зависит от доступности и аутентификации шлюза. TUI также автоматически отправляет сообщение
"Wake up, my friend!" при первом запуске. Если вы видите эту строку **без ответа** и число токенов остаётся 0, агент так и не был запущен.

1. Перезапустите шлюз:

```bash
openclaw gateway restart
```

2. Проверка статуса + автора:

```bash
статус openclaw
статус модели openclaw
журналы openclaw --follow
```

3. Если он всё равно зависает, запустите:

```bash
openclaw doctor
```

Если шлюз удален, убедитесь, что соединение туннеля/хвостового масштаба вверх и что пользовательский интерфейс
указан на правильном шлюзе. См. [Remote access](/gateway/remote).

### Могу ли я перенести свою установку на новую машину Mac мини, не делая пересадки

Да. Скопируйте **директорию** и **workspace**, затем запустите Doctor один раз. Этот
хранит ваш бот "точно таким же" (память, история сеансов, авторство и состояние канала
), пока вы копируете \*\*оба \*\* местоположения:

1. Установите OpenClaw на новую машину.
2. Скопируйте `$OPENCLAW_STATE_DIR` (по умолчанию: `~/.openclaw`) со старой машины.
3. Скопируйте ваш проект (по умолчанию: `~/.openclaw/workspace`).
4. Запустите `openclaw doctor` и перезапустите сервис шлюза.

Это сохраняет конфигурацию, профили авторизации, creds, сессии и память WhatsApp. Если вы работаете в удалённом режиме, помните, что хост gateway владеет хранилищем сессий и рабочим пространством.

**Важно:** если вы делаете только коммит/переносите рабочее пространство на GitHub, вы делаете резервную копию
вверх по **памяти + загрузочные файлы** , но **не** по истории или автору. Живые
под `~/.openclaw/` (например `~/.openclaw/agents/<agentId>/sessions/`).

Относительно: [Migrating](/install/migrating), [Где на диске](/help/faq#where-does-openclaw-store-its-data),
[Рабочая область агента](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Дистанционный режим](/gateway/remote).

### Где я вижу, что нового в последней версии

Проверьте changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Новые записи - вверху. Если верхний раздел помечен как **Неопубликованный**, следующий раздел с датой* последняя отправленная версия. Записи сгруппированы по **Выделить**, **Изменения** и
  **Исправления** (плюс документы/другие разделы, когда это необходимо).

### Я не могу получить доступ к docs.openclaw.ai ошибка SSL, что теперь

Некоторые соединения Comcast/Xfinity неправильно блокируют `docs.openclaw.ai` через расширенную безопасность Xfinity
. Отключите или включите список `docs.openclaw.ai`, затем повторите попытку. Подробнее: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Пожалуйста, помогите нам разблокировать ее, сообщая здесь: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Если вы все еще не можете выйти на сайт, документация зеркалируется на GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### В чем разница между стабильными и бета-версиями

**Стабильный** и **beta** — это **npm dist-tags**, не разделенные кодовыми строками:

- `latest` = стабильный
- `beta` = ранняя сборка для тестирования

Мы отправляем сборки на **бета-тест**, тестируем их, и после того, как мы **продвигаем
ту же самую версию в `latest`**. Поэтому бета-версия может указать на
**ту же версию**.

Посмотрите, что изменилось:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Как установить бета-версию и разница между бета-версией и dev

**Бета** — это npm dist-tag `beta` (может совпадать с `latest`).
**Dev** — движущаяся голова `main` (git); при публикации используется npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Установщик для Windows (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Подробнее: [каналы разработки](/install/development-channels) и [флаги установщика](/install/installer).

### Время установки и посадки обычно занимает

Грубое руководство:

- **Установить:** 2-5 минут
- **Онлайн:** 5-15 минут в зависимости от количества каналов/моделей, которые вы настраиваете

При зависании используйте [Установщик застрялок](/help/faq#installer-stuck-how-do-i-get-more-feedback)
и быстрый цикл отладки в [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Как я могу попробовать последние биты

Два варианта:

1. **Dev канал (git checkout):**

```bash
openclaw обновить --channel dev
```

Это переключается на главную ветку и обновляется из исходного кода.

2. **Хакерская установка (с сайта установки):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Это дает вам локальный репозиторий вы можете редактировать, а затем обновить через git.

Если вы предпочитаете чистый клон вручную, используйте:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Документы: [Update](/cli/update), [Каналы разработки](/install/development-channels),
[Install](/install).

### Установщик Застрял Как мне получить больше отзывов

Перезапустите программу установки, используя **подробный вывод**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Бета-установка с подробностями:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Для хакерской установки (git):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Больше опций: [флаги установщика](/install/installer).

### Установка Windows говорит что git не найден или openclaw не распознан

Две общие проблемы Windows:

**1) ошибка npm появление git / git не найдено**

- Установите **Git для Windows** и убедитесь, что `git` находится на вашем PATH.
- Закройте PowerShell, затем перезапустите программу установки.

**2) Openclaw не распознается после установки**

- Ваша папка npm global bin не найдена в PATH.

- Проверьте путь:

  ```powershell
  npm config get prefix
  ```

- Убедитесь, что `<prefix>\\bin` находится на PATH (на большинстве систем это `%AppData%\\npm`).

- Закройте и переоткройте PowerShell после обновления PATH.

Если вы хотите более плавную настройку Windows, используйте **WSL2** вместо обычных Windows.
Документы: [Windows](/platforms/windows).

### Доктор не ответил на мой вопрос, как мне получить лучший ответ

Используйте **взламываемую (git) установку**, чтобы иметь полный исходный код и документацию локально, а затем спрашивайте своего бота (или Claude/Codex) _из этой папки_, чтобы он мог прочитать репозиторий и ответить точно.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Подробнее: [Install](/install) и [флаги установщика](/install/installer).

### Как установить OpenClaw на Linux

Короткий ответ: следуйте инструкциям по Linux, затем запустите мастера посадочного талона.

- Быстрый путь + установка службы: [Linux](/platforms/linux).
- Полное прохождение: [Начало работы](/start/getting-started).
- Установщик + обновления: [Установить и обновить](/install/updating).

### Как установить OpenClaw в VPS

Любой Linux VPS работает. Установите на сервер, затем используйте SSH/Tailscale для достижения шлюза.

Руководства: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Удаленный доступ: [Шлюз](/gateway/remote).

### Где находятся инструкции по установке облачных VPS

Мы храним **хостинг-хаб** вместе с общими провайдерами. Выберите один и следуйте инструкции:

- [VPS хостинг](/vps) (все провайдеры в одном месте)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Как это работает в облаке: **Gateway работает на сервере**, а вы получаете к нему доступ с ноутбука/телефона через Control UI (или Tailscale/SSH). Ваше состояние и рабочее пространство находятся на сервере, поэтому считайте хост источником истины и делайте резервные копии.

Вы можете привязывать **nodes** (Mac/iOS/Android/headless) к этому облачному Gateway, чтобы получать доступ к локальному экрану/камере/холсту или запускать команды на ноутбуке, сохраняя Gateway в облаке.

Хаб: [Platforms](/platforms). Удаленный доступ: [Шлюз](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Могу ли я попросить OpenClaw обновить себя

Короткий ответ: **возможно, не рекомендуется**. Обновление может перезапустить
шлюз (который выбрасывает активный сеанс), может потребоваться очистка git оформления, и
может запросить подтверждение. Safer: запускать обновления от оболочки как оператора.

Использовать CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Если вы должны автоматизировать работу агента:

```bash
обновление openclaw --yes --no-restart
шлюз openclaw перезапустить
```

Документы: [Update](/cli/update), [Updating](/install/updating).

### Что делает мастер настройки

`openclaw onboard` - рекомендуемый путь установки. В **локальном режиме** он проходит по следующей причине:

- **Настройка модели/авторизации** (Anthropic **setup-token** рекомендуется для подписок Claude, поддержка OpenAI Codex OAuth, необязательные ключи API, поддерживаются локальные модели LM Studio)
- **Рабочая область** место + файлы bootstrap
- **Настройки шлюза** (bind/port/auth/tailscale)
- **Поставщики** (WhatsApp, Telegram, Discord, most Matter(plugin), Сигнал, iMessage)
- **Установка демона** (LaunchAgent на macOS; системное устройство пользователя на Linux/WSL2)
- **Выборки проверок** и **навыков**

Он также предупреждает, если ваша сконфигурированная модель неизвестна или отсутствует автор.

### Мне нужна подписка Claude или OpenAI, чтобы запустить это

Нет. Вы можете запустить OpenClaw с помощью **API ключей** (Anthropic/OpenAI/others) или с помощью моделей
**только локальных моделей**, чтобы данные оставались на вашем устройстве. Подписки (Claude
Pro/Max или OpenAI Codex) являются необязательными способами аутентификации этих провайдеров.

Документы: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Локальные модели](/gateway/local-models), [Models](/concepts/models).

### Могу ли я использовать подписку Claude Max без ключа API

Да. Вы можете аутентифицироваться с помощью **setup-token**
вместо ключа API. Это путь подписки.

Подписки Claude Pro/Max **не включают API-ключ**, поэтому это правильный подход для аккаунтов с подпиской. Важно: вы должны проверить с помощью
антропии, что это использование разрешено в соответствии с их политикой подписки и условиями.
Если вы хотите откровенно поддерживаемый путь, используйте ключ Anthropic API.

### Как работает авторизация антропии

`claude setup-token` генерирует **token string** через CLI кода Claude Code (он не доступен в веб-консоли). Вы можете запустить его на **любой машине**. Выберите **Anthropic token (вставьте фразу setup-token)** в мастере или вставьте его с помощью `openclaw models auth paste-token --provider anthropic`. Токен хранится как профиль авторизации для поставщика **антропический** и используется как API ключ (без автообновления). Подробнее: [OAuth](/concepts/oauth).

### Где я нахожу настройки антропии

Это **не** в антропической консоли. Маркер setup-token генерируется **Claude Code CLI** на **любом компьютере**:

```bash
claude setup-token
```

Скопируйте токен, который он печатает, а затем выберите **Anthropic token (вставьте токен setup-token)** в мастере настройки. Если вы хотите запустить его на шлюзе хоста, используйте `openclaw models auth setup-token --provider anthropic`. Если вы запускали `claude setup-token` в другом месте, вставьте его на хост шлюза с помощью `openclaw models auth paste-token --provider anthropic`. См. [Anthropic](/providers/anthropic).

### Поддерживаете авторизацию подписки Claude (Claude Pro или Max)

Да - через **setup-token**. OpenClaw больше не использует ключи Claude Code CLI OAuth; используйте ключ setup-token или ключ Anthropic API. Генерируйте токен где угодно и вставьте его на хост шлюза. См. [Anthropic](/providers/anthropic) и [OAuth](/concepts/oauth).

Примечание: Доступ к подписке Claude регулируется условиями антропии. Для производственных или многопользовательских рабочих загрузок, API ключи обычно являются более безопасным выбором.

### Почему я вижу HTTP 429 ratelimiterror от антропических

Это означает, что ваш **Антропический лимит** исчерпан для текущего окна. Если вы используете **подписку Claude** (setup-token или Claude Code OAuth), дождитесь сброса окна лимитов или обновите тариф. Если вы используете **Anthropic API ключ**, проверьте Anthropic Console
для использования/выставления счетов и повышения лимитов при необходимости.

Подсказка: установите **резервную модель** для того, чтобы OpenClaw мог отвечать, в то время как провайдер ограничен.
См. [Models](/cli/models) и [OAuth](/concepts/oauth).

### Поддерживается AWS Bedrock

Да - через **Amazon Bedrock (Converse)** провайдер с **ручным config**. Вы должны предоставить учетные данные AWS на хосте шлюза и добавить запись провайдера Bedrock в конфигурацию вашей модели. См. [Amazon Bedrock](/providers/bedrock) и [Model providers](/providers/models). Если вы предпочитаете управляемый поток ключей, то совместимый с OpenAI прокси перед Bedrock все еще является допустимым вариантом.

### Как работает авторизация Codex

OpenClaw поддерживает **OpenAI Code (Codex)** через OAuth (ChatGPT вход). Мастер может запустить поток OAuth и установить модель по умолчанию в `openai-codex/gpt-5.3-codex` при необходимости. См. [Модели провайдеров](/concepts/model-providers) и [Wizard](/start/wizard).

### Поддерживаете ли вы OAuth авторизации подписки OpenAI

Да. OpenClaw полностью поддерживает OAuth\*\* подписку на OpenAI Code (Codex). Мастер настройки
может запустить OAuth для вас.

См. [OAuth](/concepts/oauth), [Модели провайдеров](/concepts/model-providers) и [Wizard](/start/wizard).

### Как настроить Gemini CLI OAuth

Gemini CLI использует **поток авторизации плагинов**, а не идентификатор клиента или секрет в `openclaw.json`.

Шаги:

1. Включить плагин: `openclaw плагины включить google-gemini-cli-auth`
2. Войти: `openclaw models auth login --provider google-gemini-cli --set-default`

Это хранит токены OAuth в профилях auth на хосте шлюза. Подробности: [Модель провайдеров](/concepts/model-providers).

### Локальная модель для случайных чатов

Обычно нет. OpenClaw требует большого контекста + надежной безопасности; маленькие карты усекаются и протекают. Если вы должны, запустите **наибольшаю** сборку MiniMax M2.1, которую вы можете загрузить локально (LM Studio) и посмотреть [/gateway/local-models](/gateway/local-models). Маленькие/количественные модели увеличивают риск быстрого впрыска - см. [Security](/gateway/security).

### Как хранить трафик модели хостинга в определенном регионе

Выберите закрепленные на региональном уровне конечные точки. OpenRouter предоставляет опции для MiniMax, Kimi и GLM с американским хостингом; выберите вариант хранения данных в регионе. Вы все еще можете перечислить антропные/OpenAI вместе с ними с помощью `models.mode: "merge"`, так что запасы останутся доступными при уважении выбранного поставщика регионами.

### Нужно ли мне купить Mac Mini для установки

Нет. OpenClaw работает с macOS или Linux (Windows через WSL2). Mac mini необязателен — некоторые покупают его как постоянно включённый хост, но небольшой VPS, домашний сервер или устройство класса Raspberry Pi тоже подойдёт.

Вам нужен только один Mac **для инструментов только macOS**. Для iMessage, используйте [BlueBubbles](/channels/bluebubbles) (рекомендуется) - сервер BlueBubbles работает на любом Mac, а шлюз может работать в Linux или в другом месте. Если вы хотите использовать другие утилиты только для macOS, запустите шлюз на Mac или подключите узел macOS.

Документы: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [удаленный режим Mac](/platforms/mac/remote).

### Нужен ли мне Mac mini для поддержки iMessage

Вам нужно **некоторое macOS устройство** подписанное в сообщения. **Не** должен быть Mac mini -
любой Mac работает. **Используйте [BlueBubbles](/channels/bluebubbles)** (рекомендуется) для iMessage - сервер BlueBubbles работает на macOS, в то время как шлюз может работать в Linux или в другом месте.

Общие настройки:

- Запустите шлюз на Linux/VPN и запустите сервер BlueBubbles на любом Mac, подписанном в Сообщения.
- Запустите все на Mac, если хотите простейшей установки однотипной машины.

Документы: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[удаленный режим Mac](/platforms/mac/remote).

### Если я покупаю Mac мини-для запуска OpenClaw я могу подключить его к моему MacBook Pro

Да. **Мак мини может запустить шлюз** и ваш MacBook Pro может подключаться как
**node** (устройство-компаньон). Nodes не запускают Gateway — они предоставляют дополнительные возможности, такие как экран/камера/холст и `system.run` на этом устройстве.

Общий узор:

- Шлюз на Mac mini (всегда).
- MacBook Pro запускает приложение macOS или узел и пары шлюза.
- Используйте `openclaw nodes status` / `openclaw list` чтобы увидеть его.

Документация: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Можно использовать Жемчуг

Bun **не рекомендуется**. Мы видим ошибки во время выполнения работы, особенно с WhatsApp и Telegram.
Используйте **Node** для стабильных шлюзов.

Если вы всё же хотите поэкспериментировать с Bun, делайте это на небоевом gateway без WhatsApp/Telegram.

### Telegram что идёт от

`channels.telegram.allowFrom` - **идентификатор пользователя в Telegram** человека (число, рекомендуется) или `@username`. Это не имя пользователя бота.

Безопаснее (без стороннего бота):

- DM ваш бот, затем запустите `openclaw logs --follow` и прочитайте `from.id`.

Официальные боты API:

- Твой бот, затем позвоните в `https://api.telegram.org/bot<bot_token>/getUpdates` и прочитайте файл `message.from.id`.

Сторонние варианты (менее приватно):

- DM `@userinfobot` или `@getidsbot`.

См. [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Позволяет нескольким людям использовать один номер WhatsApp с разными экземплярами OpenClaw

Да, с помощью **маршрута нескольких агентов**. Привязка каждого отправителя WhatsApp **DM** (пир `kind: "dm"`, отправитель E. «+15551234567») другому агенту, таким образом, каждый человек получает свое собственное рабочее пространство и хранилище. Ответы все еще поступают от **той же учетной записи WhatsApp**, и контроля доступа к DM (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) является глобальным в каждой учетной записи WhatsApp. См. [Мульти-Агент маршрутизация](/concepts/multi-agent) и [WhatsApp](/channels/whatsapp).

### Могу ли я запустить быстрый чат агента и Opus для программирования агента

Да. Используйте маршрутизацию нескольких агентов: дайте каждому агенту свою собственную модель по умолчанию, затем привязывайте входящие маршруты (учетные записи провайдера или узлы) каждому агенту. Пример конфигурации живет в [маршрутизации нескольких агентов](/concepts/multi-agent). См. также [Models](/concepts/models) и [Configuration](/gateway/configuration).

### Работает ли Homebrew в Linux

Да. Homebrew поддерживает Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Если вы запускаете OpenClaw через систему, убедитесь, что в службе PATH включены `/home/linuxbrew/.linuxbrew/bin` (или ваш префикс brew) так что `brew`-установленные инструменты разрешены в не-login оболочках.
Последние сборки также предписывают общие пользовательские бин-диры на сервисах системы Linux (например, `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) и honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` и `FNM_DIR` при установленном значении.

### В чем разница между хакерской установкой git и npm установкой

- **Установка для взлома (git):** полная проверка исходного кода, редактируемая, лучше всего для участников.
  Вы запускаете сборки локально и можете модифицировать код/документы.
- **npm установка:** глобальная установка CLI, нет репо, лучше всего "просто запустить его."
  Обновления поступают из npm dist-tags.

Документы: [Начало работы](/start/getting-started), [Updating](/install/updating).

### Могу ли я переключаться между установками npm и git позже

Да. Установите другой флажок, а затем запустите Доктор, чтобы точки обслуживания шлюзов в новой точке входа.
Этот **не удаляет ваши данные** — он только изменяет установочный код OpenClaw. Ваше состояние (`~/.openclaw`) и рабочее пространство (`~/.openclaw/workspace`) остаются нетронутыми.

От npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

От git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor обнаруживает несоответствие входной точки шлюза и предлагает переписать конфигурацию службы в соответствие с текущей установкой (используйте `--repair` в автоматизации).

Советы резервного копирования: см. [Стратегия резервного копирования](/help/faq#whats-the-recommended-backup-strategy).

### Если я запускаю шлюз на моем ноутбуке или VPS

Короткий ответ: **если вы хотите 24/7, используйте VPS**. Если вы хотите, чтобы
было меньше трения и у вас нормально со сном/перезапустите его локально.

**Лаптоп (локальный шлюз)**

- **Pros:** сервер не стоит, прямой доступ к локальным файлам, окно онлайн браузера.
- **Понят:** спать/сетевые потери = отключение, прерывание обновлений/перезагрузки операционной системы, необходимо оставаться в стороне.

**VPS / облачно**

- **Pros:** постоянная, стабильная сеть, нет проблем со сном ноутбука, легче работать.
- **Согласы:** часто запускают без заголовков (используйте скриншоты), только доступ к удаленным файлам, вы должны SSH для обновлений.

**Примечание для OpenClaw:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord прекрасно работает с VPS. Единственный реальный трейдинг - **бесконечный браузер** и видимое окно. См. [Browser](/tools/browser).

**Рекомендуется по умолчанию:** VPS, если ранее у вас были отключены шлюзы. Локальный отлично, когда вы активно используете Mac и хотите получить локальный доступ к файлам или автоматизацию пользовательского интерфейса при помощи видимого браузера.

### Насколько важно запустить OpenClaw на выделенной машине

Не требуется, но **рекомендовано для надежности и изоляции**.

- **Специализированный хост (VPS/Mac mini/Pi):** всегда меньше, меньше сна/перезагрузки прерываний, более чистых разрешений, легче продолжать работать.
- **Общий ноутбук/рабочий стол:** полностью подходит для тестирования и активного использования, но ожидать паузы при спящем или обновлении машины.

Если вы хотите лучшее из обоих миров, Сохраните шлюз на выделенном хосте и подключите ваш ноутбук в качестве **узла** для локальных инструментов экрана/камеры/exec. См. [Nodes](/nodes).
Для рекомендаций по безопасности прочитайте [Security](/gateway/security).

### Каковы минимальные требования к VPS и рекомендуемая ОС

OpenClaw это легкий вес. Для базового шлюза + одного чата:

- **Абсолютный минимум:** 1 vCPU, 1GB RAM, ~500MB диск.
- **Рекомендуется:** 1-2 vCPU, 2GB RAM или более для головных уборов (журналы, медиа, несколько каналов). Узловые инструменты и автоматизация браузера может быть ресурсоемким.

ОС: использование **Ubuntu LTS** (или любого современного Debian/Ubuntu). Здесь лучше всего протестировать путь установки Linux.

Документы: [Linux](/platforms/linux), [VPS хостинг](/vps).

### Могу ли я запустить OpenClaw в ВМ и какие требования

Да. считая ВМ такой же, как и VPS: он должен быть всегда включен, доступен, и иметь достаточно
ОЗУ для шлюза и всех подключенных каналов.

Руководящие указания по базовой линии:

- **Абсолютный минимум:** 1 vCPU, 1GB RAM.
- **Рекомендуется:** 2ГБ ОЗУ или более, если вы запускаете несколько каналов, автоматизацию браузера или медиа-инструментов.
- **ОС:** Ubuntu LTS или другой современный Debian/Ubuntu.

Если вы находитесь в Windows, **WSL2 это самая легкая настройка VM стиля** и имеет лучшую инструментальную
совместимость. Смотрите [Windows](/platforms/windows), [VPS хостинг](/vps).
Если вы запускаете macOS в VM, смотрите [macOS VM](/install/macos-vm).

## Что такое OpenClaw?

### Что такое OpenClaw в одном абзаце

OpenClaw это личный помощник AI вы работаете на ваших собственных устройствах. Отвечает на уже используемые вами сообщения (WhatsApp, Telegram, Slack, Mattermost (плагин), Discord, Чат Google, сигнал, iMessage, WebChat), а также может голосовать + живой холст на поддерживаемых платформах. **Шлюз** — это постоянный контрольный план, помощник — продукт.

### Что представляет ценность

OpenClaw это не «просто оболочка Claude.» Это **первая локальная система управления**, которая позволяет вам запускать
на **вашем собственном оборудовании**, доступно из уже используемых чат-приложений, с
состоятельными сессиями, памятью и инструментами - без контроля ваших рабочих процессов с размером
SaaS.

Выделить:

- **Ваши устройства, ваши данные:** запускайте Gateway где угодно (Mac, Linux, VPS) и храните рабочее пространство и историю сессий локально.
- **Реальные каналы, а не песочница:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  плюс мобильный голос и холст на поддерживаемых платформах.
- **Моделирование:** используйте антропию, OpenAI, MiniMax, OpenRouter и т.д., с маршрутизацией по агентам
  и отказом.
- **Локальная опция:** запустите локальные модели, чтобы **все данные оставались на вашем устройстве**, если хотите.
- **Маршрутизация с несколькими агентами:** отдельные агенты для каждого канала, аккаунта или задачи, каждый со своим рабочим пространством и настройками по умолчанию.
- **Открытый исходный код и хакер:** проверять, расширять и самому хосту без блокировки поставщика.

Документы: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Я просто настрою, что я должен сделать

Хорошие первые проекты:

- Создайте сайт (WordPress, Shopify, или простой статический сайт).
- Прототип мобильного приложения (контур, экраны, API план).
- Упорядочить файлы и папки (очистка, имя, тег).
- Подключите Gmail и автоматизируйте сводки или следуйте за ними.

Он может справиться с большими задачами, но работает лучше всего при разделении их на фазы, и
для параллельной работы используйте подагенты.

### Каковы пять лучших вариантов повседневного использования OpenClaw

Ежедневные победы обычно выглядят так:

- **Личные брифинги:** резюме, календарь и новости о вас.
- **Исследование и разработка:** краткие исследования, резюме и первые проекты электронной почты или документов.
- **Напоминания и последующие действия:** cron или heartbeat прогоны и контрольные списки.
- **Автоматизация браузера:** заполнение форм, сбор данных и повторение веб-задач.
- **Поперечная координата устройства:** Отправьте задание с телефона, пусть шлюз запускает его на сервере, и получите результат в чате.

### Может помочь OpenClaw с информационно-пропагандистской кампанией и блогами для SaaS

Да для **исследований, квалификации и черновика**. Он может сканировать сайты, составлять короткие списки, суммировать потенциальных клиентов и писать черновики аутрича или рекламных текстов.

Для **охвата или запуска объявлений** держите человека в цикле. Избегайте спама, следуйте местным законам и политике платформы
и оставляйте отзыв перед отправкой. Самый безопасный шаблон должен позволить
OpenClaw черновик и вы принимаете.

Документы: [Security](/gateway/security).

### Каковы преимущества и код Claude для веб-разработки

OpenClaw — это **личный помощник** и координационный уровень, а не замена IDE. Используйте
Claude Code или Codex для самого быстрого прямого цикла кодинга внутри репозитория. Используйте OpenClaw, когда
нужна долговременная память, доступ с разных устройств и оркестрация инструментов.

Преимущества:

- **Постоянная память + рабочая область** между сессиями
- **Многоплатформенный доступ** (WhatsApp, Telegram, TUI, WebChat)
- **Инструмент оркестра** (браузер, файлы, планирование, хуки)
- **Всегда включенный шлюз** (работает на VPS, взаимодействует отовсюду)
- **Узлы** для локального браузера/экрана/камеры/exec

Показатель: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Навыки и автоматизация

### Как настроить навыки без сохранения репозитория

Использовать управляемые переопределения вместо редактирования копии репозитория. Поместите ваши изменения в `~/.openclaw/skills/<name>/SKILL.md` (или добавьте папку через `skills.load.extraDirs` в `~/.openclaw/openclaw.json`). Приоритет `<workspace>/skills` > `~/.openclaw/skills` > объединен, так что управляемый переопределяет победу без прикосновения git. Только восприимчивые правки должны жить в репозитории и выходить как PR.

### Могу ли я загрузить навыки из пользовательской папки

Да. Добавьте дополнительные каталоги через `skills.load.extraDirs` в файл `~/.openclaw/openclaw.json` (самый низкий приоритет). Значение по умолчанию осталось: `<workspace>/skills` → `~/.openclaw/skills` → в комплекте → `skills.load.extraDirs`. `clawhub` по умолчанию устанавливается в `./skills`, который OpenClaw считается `<workspace>/skills`.

### Как я могу использовать различные модели для различных задач

Сегодня поддерживаемые шаблоны:

- **Cron задания**: изолированные задания могут установить `модель` переопределение одной работы.
- **Подагенты**: задачи маршрута к отдельным агентам с различными моделями по умолчанию.
- **Переключатель по требованию**: используйте `/model` для переключения текущей модели сеанса в любое время.

См. [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent) и [Slash commands](/tools/slash-commands).

### Бот замерзает при выполнении тяжелой работы Как я могу выгрузить

Используйте **субагенты** для длительных или параллельных задач. Субагенты работают в собственной сессии,
возвращают краткое резюме и сохраняют отзывчивость основного чата.

Попросите вашего бота "создать субагента для этой задачи" или используйте `/subagents`.
Используйте `/status` в чате, чтобы увидеть, что шлюз делает прямо сейчас (и есть ли он занят).

Подсказка по токен: длинные задачи и суб-агенты потребляют токены. Если стоимость является проблемой, установите
более дешевую модель для субагентов через `agents.defaults.subagents.model`.

Документы: [Sub-agents](/tools/subagents).

### Cron или напоминания не пожар Что я должен проверить

Cron запускается внутри шлюза. Если Gateway не запущен непрерывно,
запланированные задания выполняться не будут.

Checklist:

- Подтверждение включения cron (`cron.enabled`) и не задан `OPENCLAW_SKIP_CRON`.
- Проверьте работу шлюза 24/7 (без сна/перезапуска).
- Проверьте настройки часового пояса для задания (`--tz` против часового пояса хоста).

Debug:

```bash
cron openclaw run <jobId> --force
openclaw cron run --id <jobId> --limit 50
```

Доки: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Как установить навыки на Linux

Используйте **ClawHub** (CLI) или сбрасывайте навыки в рабочее пространство. Интерфейс macOS навыков недоступен в Linux.
Просмотреть навыки по адресу [https://clawhub.com](https://clawhub.com).

Установите ClawHub CLI (выберите один менеджер пакетов):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Может OpenClaw запускать задачи на графике или постоянно в фоновом режиме

Да. Использовать планировщик шлюзов:

- **Cron задания** для запланированных или повторяющихся задач (сохраняется через перезапуск).
- **Сербет** для "основной сессии" периодических проверок.
- **Изолированные работы** для автономных агентов, которые отправляют резюме или доставляют в чат.

Доки: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Могу ли я использовать только навыки Apple macOS из Linux?

Не напрямую. Навыки macOS закрываются `metadata.openclaw.os` плюс требуемые бинарные файлы, и навыки отображаются только в системных подсказках, когда они имеют право на **Gateway host**. В Linux навыки `darwin`-only (например `apple-notes`, `apple-reminders`, `things-mac`) не будут загружаться, если вы не переопределите ворота.

У вас есть три поддерживаемых шаблона:

\*\*Опция A - запускайте шлюз на Mac (простое). \*
Запустите шлюз, где существует исполняемые файлы macOS, затем подключитесь из Linux в [удаленном режиме](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) или через Tailscale. Нагрузка навыков, как правило, потому что хост шлюза - macOS.

\*\*Опция B - используйте узел macOS (без SSH). \*
Запустите шлюз в Linux, свяжите узел macOS (приложение menubar), и установите **Команды запуска узла** на «Всегда спрашивать» или «Всегда разрешать» на Mac. OpenClaw может относиться к навыкам macOS так же, как это применимо, когда на узле существует требуемый двоичный файл. Агент работает с этими навыками с помощью инструмента `nodes`. Если вы выберете «Всегда спрашивать», одобрение «Always Allow» в запросе добавляет эту команду в список allowlist.

\*\*Option C - макросы прокси по SSH (advanced). \*
Сохранять шлюз в Linux, но сделать необходимые файлы CLI разрешены для оболочки SSH, работающие на Mac. Затем переопределите навык, чтобы Linux мог оставаться правомочным.

1. Создайте обёртка SSH для двоичного файла (пример: `memo` для Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Поместите обертку в `PATH` на хост Linux (например, `~/bin/memo`).

3. Переопределить метаданные навыка (рабочая область или `~/.openclaw/skills`), чтобы позволить Linux:

   ```markdown
   ---
   name: apple-notes
   description: Управление Apple Notes через CLI memo на macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Начните новую сессию, чтобы обновился снимок навыков.

### Есть ли у вас узел или интеграция HeyGen

Сегодня не встроено.

Варианты:

- **Пользовательский навык / плагин:** лучший для надежного доступа к API (Notion/HeyGen оба имеют API).
- **Автоматизация браузера:** работает без кода, но медленнее и хрупче.

Если вы хотите сохранить контекст для каждого клиента (работающие на студии), простая схема:

- Одна страница Notion на клиента (в контексте + предпочтения + активная работа).
- Попросите агента получить эту страницу в начале сессии.

Если вам нужна нативная интеграция, откройте запрос на функциональность или создайте навык,
нацеленный на эти API.

Установить навыки:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub устанавливается в `. skills` под вашим текущим каталогом (или относится к вашему настроенному рабочему пространству OpenClaw); OpenClaw обрабатывает это как `<workspace>/skills` на следующей сессии. Для обмена навыками между агентами поместите их в `~/.openclaw/skills/<name>/SKILL.md`. Некоторые навыки ожидают, что бинарные файлы будут установлены через Homebrew; в Linux это означает Linuxbrew (см. пункт Homebrew Linux FAQ выше). См. [Skills](/tools/skills) и [ClawHub](/tools/clawhub).

### Как установить расширение Chrome для захвата браузера

Используйте встроенную программу установки, а затем загрузите распакованное расширение в Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Затем Chrome → `chrome://extensions` → включить "Developer mode" → "Load unpacked" → выбрать эту папку.

Полное руководство (включая удаленный шлюз + примечания безопасности): [Расширение Chrome](/tools/chrome-extension)

Если шлюз работает на той же машине, что и Chrome (настройки по умолчанию), то **обычно не требуйте** ничего дополнительного.
Если Gateway запущен в другом месте, запустите хост узла на машине с браузером, чтобы Gateway мог проксировать действия браузера.
Вам все еще нужно нажать кнопку расширения на вкладке вы хотите контролировать (она не автоматически прикрепляется).

## Песочница и память

### Есть ли специальная доска для песочницы

Да. См. [Sandboxing](/gateway/sandboxing). Для настройки для Docker-а (полный шлюз в изображениях Docker или sandbox), см. [Docker](/install/docker).

### Docker чувствует ограниченность как включить полные функции

Образ по умолчанию ориентирован на безопасность и запускается от пользователя `node`, поэтому он не
включает системные пакеты, Homebrew или встроенные браузеры. Для более полных настроек:

- Удерживайте `/home/node` с помощью `OPENCLAW_HOME_VOLUME` так что оставайтесь в тайнике.
- Система выпекает на изображение с помощью `OPENCLAW_DOCKER_APT_PACKAGES`.
- Установить Playwright браузеры через CLI комплекта:
  `node /app/node_modules/playwright-core/cli.js установить chromium`
- Установите `PLAYWRIGHT_BROWSERS_PATH` и убедитесь, что путь сохраняется.

Документы: [Docker](/install/docker), [Browser](/tools/browser).

**Могу ли я хранить ЛС в личном кабинете, но сделать группу публичной в песочнице одним агентом**

Да - если ваш личный трафик **DMs**, а ваш публичный трафик **группы**.

Используйте `agents.defaults.sandbox.mode: "non-main"` так что group/channel sessions (non-main keys) run in Docker, while the main DM session still on host. Затем ограничите, какие инструменты доступны в песочнице сессий через `tools.sandbox.tools`.

Настройка прохождения + пример конфигурации: [Группа: персональные ЛС + публичные группы](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Ключевые настройки ссылки: [Конфигурация шлюза](/gateway/configuration#agentsdefaultssandbox)

### Как связать папку с хостом в песочнице

Установите `agents.defaults.sandbox.docker.binds` на `["host:path:mode"]` (например, `"/home/user/src:/src:ro"`). Глобальное объединение двоичных файлов + для каждого агента; двоичные файлы для каждого агента игнорируются, когда `scope: "shared"`. Используйте `:ro` для любых чувствительных и запоминающихся привязок, обойдя стену песочницы. См. [Sandboxing](/gateway/sandboxing#custom-bind-mounts) и [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) для примеров и примечаний по безопасности.

### Как работает память

Память OpenClaw это только файлы Markdown в рабочей области агента:

- Ежедневные заметки в `memory/YYY-MM-DD.md`
- Курируемые долговременные ноты в папке `MEMORY.md` (только для главных/частных сессий)

OpenClaw также выполняет **тихую предварительную очистку памяти перед компактацией**, чтобы напомнить модели
записать долговременные заметки перед авто-компактацией. Это выполняется только тогда, когда рабочее пространство
доступно для записи (песочницы только для чтения пропускают это). См. [Память](/concepts/memory).

### Память продолжает забывать о том, как я могу придержаться

Попросите бота **написать факт в памяти**. Долгосрочные заметки находятся в `MEMORY.md`,
краткосрочный контекст идет в `memory/YYYY-MM-DD.md`.

Это еще одна область, которую мы улучшаем. Это помогает напомнить модели сохранять воспоминания;
она будет знать, что делать. Если это не забывает, проверьте, что шлюз использует одно и то же рабочее пространство
при каждом запуске.

Документы: [Memory](/concepts/memory), [Рабочая область агента](/concepts/agent-workspace).

### Требуется семантический ключ OpenAI API

Только если вы используете **OpenAI встраивания**. OAuth Codex покрывает чат/доработки и
**не** предоставляет встраиваемый доступ, поэтому **вход с помощью Codex (OAuth или
Codex CLI)** не помогает поиску семантической памяти. Встраивания OpenAI
по-прежнему требуют реальный API-ключ (`OPENAI_API_KEY` или `models.providers.openai.apiKey`).

Если вы не устанавливаете провайдера явно, OpenClaw автоматически выбирает провайдера, когда он
может разрешить ключ API (авторизованные профили, `models.providers.*.apiKey` или env vars).
Он предпочитает OpenAI, если позволяет OpenAI ключ, иначе Gemini разрешает ключ Gemini
. Если ни один из ключей не доступен, поиск по памяти отключен до тех пор, пока вы не
настройте его. Если у вас есть путь к локальной модели настроен и присутствует, OpenClaw
предпочитает `local`.

Если вы предпочитаете оставаться локальным, установите `memorySearch.provider = "local"` (и опционально
`memorySearch.fallback = "нет"`). Если вы хотите встраивать Gemini, установите
`memorySearch.provider = "gemini"` и предоставьте `GEMINI_API_KEY` (или
`memorySearch.remote.apiKey`). Мы поддерживаем **OpenAI, Gemini, или локальные** встраиваемые
модели - см. [Memory](/concepts/memory).

### Остается ли память навсегда. Что такое ограничения

Файлы памяти на диске сохраняются до тех пор, пока вы не удалите их. Ограничение — это ваше
хранилище, а не модель. Контекст **сессии** все еще ограничен контекстным окном
, так что длинные разговоры могут быть сжаты или усечены. Вот почему существует поиск памяти* он возвращает в контекст только релевантные части.

Документы: [Memory](/concepts/memory), [Context](/concepts/context).

## Куда вещи живут на диске

### Все данные используются с OpenClaw локально

Нет - **OpenClaw's это локальный**, но **внешние сервисы все еще видят**.

- **Локально по умолчанию:** сессии, файлы памяти, конфигурация и рабочее пространство находятся на хосте Gateway
  (`~/.openclaw` + каталог вашего рабочего пространства).
- **Удаленное по необходимости:** сообщения, отправляемые поставщикам моделей (Anthropic/OpenAI/и т.д.) перейдите на
  их API и общайтесь на платформах (WhatsApp/Telegram/Slack/etc.) хранят данные сообщений на своих
  серверах.
- **Вы контролируете след:** использование локальных моделей оставляет промпты на вашей машине, но трафик канала
  всё равно проходит через серверы канала.

Связанный: [Рабочая область Агента](/concepts/agent-workspace), [Memory](/concepts/memory).

### Где OpenClaw сохраняет свои данные

Все живет под `$OPENCLAW_STATE_DIR` (по умолчанию: `~/.openclaw`):

| Путь                                                            | Назначение                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Главная конфигурация (JSON5)                                                     |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Импорт старого OAuth (скопирован в профили авторизации при первом использовании) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Профили авторизации (OAuth + API ключей)                                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Кэш авторизации Runtime (управляется автоматически)                              |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Состояние провайдера (например, `whatsapp/<accountId>/creds.json`)               |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Состояние агента (agentDir + сеансы)                                             |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | История разговоров и состояние (по агентам)                                      |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Метаданные сессии (по каждому агенту)                                            |

Старый одноагентный путь: `~/.openclaw/agent/*` (мигрирован врачом `openclaw`).

Ваша **рабочая область** (AGENTS.md, файлы памяти, навыки и т. д.) является отдельным и настраивается через `agents.defaults.workspace` (по умолчанию: `~/.openclaw/workspace`).

### Где должны существовать АГЕНТМЫ ПОЛЬЗОВАТЕЛЯ MEMORYmd

Эти файлы живут в **рабочей области агента**, а не в `~/.openclaw`.

- **Рабочая область (каждый агент)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (или `memory.md`), `memory/YYYY-MM-DD.md`, опционально `HEARTBEAT.md`.
- **Каталог состояния (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  и общие навыки (`~/.openclaw/skills`).

Рабочая область по умолчанию `~/.openclaw/workspace`, настраиваемая:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Если бот «забывает» после перезапуска, убедитесь, что Gateway использует одно и то же
рабочее пространство при каждом запуске (и помните: удалённый режим использует **рабочее пространство хоста Gateway**,
а не вашего локального ноутбука).

Совет: если вам нужно долговременное поведение или предпочтение, попросите бота **записать это в
AGENTS.md или MEMORY.md**, а не полагаться на историю чата.

См. [Рабочая область агента](/concepts/agent-workspace) и [Memory](/concepts/memory).

### Какова рекомендуемая стратегия резервного копирования

Поместите вашу **рабочую область агента** в **приватный** git repo и сделайте резервную копию где-то
частного (например, приватного GitHub). Это фиксирует память + AGENTS/SOUL/USER
файлов и позволяет вам восстановить "разум помощника" позже.

**Нет** зафиксируйте что-либо в `~/.openclaw` (учетные данные, сессии, токены).
Если вам нужно полностью восстановить, сделайте резервную копию как рабочей области, так и директории состояний
отдельно (см. вопрос миграции выше).

Документы: [Рабочая область агента](/concepts/agent-workspace).

### Как полностью удалить OpenClaw

Смотрите выделенное руководство: [Uninstall](/install/uninstall).

### Может ли агенты работать вне рабочей области

Да. Рабочая область - **по умолчанию** и якорь памяти, а не жёсткий песочник.
Относительные пути разрешены внутри рабочей области, но абсолютные пути могут получить доступ к другим координатам
хостов, если не включена коробка "песочница". Если вам нужна изоляция, используйте параметры
[`agents.defaults.sandbox`](/gateway/sandboxing) или per-agent "песочница". Если вы
хотите, чтобы репозиторий был рабочим каталогом по умолчанию, укажите `workspace` агента
`workspace` в корень репозитория. Репозиторий OpenClaw является только исходным кодом; оставьте рабочее пространство
отдельным, если вы намеренно не хотите, чтобы агент работал внутри него.

Пример (репозиторий по умолчанию):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im in remote mode where is the session store

Состояние сессии принадлежит **шлюзу**. Если вы находитесь в удаленном режиме, хранилище сеансов находится на удаленной машине, а не на локальном ноутбуке. См. [Управление сессиями] (/concepts/session).

## Основы конфигурации

### [В каком формате конфиг и где он находится?](#what-format-is-the-config-where-is-it)

OpenClaw читает необязательную **JSON5** конфигурацию из `$OPENCLAW_CONFIG_PATH` (по умолчанию: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Если файл отсутствует, он использует настройки безопасности (включая рабочую область по умолчанию `~/.openclaw/workspace`).

### Я установил шлюз Lan или хвостовая сеть, и теперь ничего не слушает пользовательский интерфейс говорит о несанкционированном

Не циклические связывания **требуют автора**. Настройте `gateway.auth.mode` + `gateway.auth.token` (или используйте `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

Notes:

- `gateway.remote.token` предназначен только для **удалённых CLI вызовов**; это не позволяет использовать локальный шлюз auth.
- Интерфейс управления аутентифицируется через `connect.params.auth.token` (хранится в настройках app/UI). Избегайте размещения токенов в URL.

### Зачем мне нужен токен на localhost

Мастер генерирует токен шлюза по умолчанию (даже на цикле), поэтому **локальные WS клиенты должны аутентифицировать**. Это блокирует другие локальные процессы от вызова шлюза. Вставьте токен в настройки Control UI (или клиентскую конфигурацию) для подключения.

Если вы **really** хотите открыть loopback, удалите `gateway.auth` из конфигурации. Доктор может генерировать токен для вас в любое время: `openclaw doctor --generate-gateway-token`.

### Нужно ли мне перезапустить после изменения конфигурации

Шлюз наблюдает за конфигурацией и поддерживает перезагрузку:

- `gateway.reload.mode: "hybrid"` (по умолчанию): горячие и безопасные изменения, перезапустите критические
- `hot`, `restart`, `off` также поддерживается

### Как включить веб-поиск и веб-выборку

`web_fetch` работает без ключа API. `web_search` требует ключ Brave Search
. **Рекомендуется:** выполните `openclaw configure --section web`, чтобы сохранить это в
`tools.web.search.apiKey`. Альтернатива через окружение: установите `BRAVE_API_KEY` для процесса
Gateway.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      выбор: {
        enabled: true,
      },
    },
  },
}
```

Примечания:

- Если вы используете разрешенные списки, добавьте `web_search`/`web_fetch` или `group:web`.
- `web_fetch` включён по умолчанию (если явно не отключён).
- Демоны читают env vars из `~/.openclaw/.env` (или среды службы).

Документация: [Web tools](/tools/web).

### Как запустить центральный шлюз со специализированными работниками между устройствами

Общая схема — **один шлюз** (например, малины\*\* плюс **узлы** и **агенты**:

- **Шлюз (центральный):** владеет каналами [Подпись/WhatsApp), маршрутизацией и сессиями.
- **Узлы (устройства):** Macs/iOS/Android соединяются как периферийные устройства и создают локальные инструменты (`system.run`, `canvas`, `camera`).
- **Агенты (работники):** отдельные мозги/рабочие пространства для специальных ролей (например, "Хетцнер опс", "Личные данные").
- **Подагенты:** создаёт фоновую работу основного агента, когда вы хотите параллелизма.
- **TUI:** подключитесь к шлюзу и переключите агентов/сессий.

Документы: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Может ли браузер OpenClaw работать без заголовков

Да. Это опция конфигурации:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

По умолчанию «false» (headful). Более вероятно, что Headless запускает проверку антиботов на некоторых сайтах. См. [Browser](/tools/browser).

Бесконечно использует **тот же Хромиум** и работает для большинства автоматизированных систем (формы, клики, скрапение, логины). Основные отличия:

- Нет видимого окна браузера (используйте скриншоты, если вам нужны изображения).
- Некоторые сайты более строгие по отношению к автоматизации в безголовном режиме (CAPTCHA, anti-bot).
  Например, X/Twitter часто блокирует бесголовные сеансы.

### Как использовать Brave для управления браузером

Установите `browser.executablePath` на ваш двоичный файл Brave (или любой браузер на базе Chromium) и перезапустите шлюз.
Смотрите полные примеры конфигурации в [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Удаленные шлюзы и узлы

### Как команды распространяются между Telegram шлюзом и узлами

Сообщения Telegram обрабатываются **шлюзом**. Шлюз запускает агента и
только после этого вызывает узлы через **Шлюз WebSocket**, когда требуется инструмент узла:

Телеграмма → Шлюз → Агент → `Node.*` → Узел → Шлюз → Телеграмма

Узлы не видят входящего трафика провайдера; они принимают только RPC звонки.

### Как агент может получить доступ к моему компьютеру, если шлюз размещен удаленно

Короткий ответ: **сопряжьте компьютер в качестве узла**. Gateway работает в другом месте, но он может
вызывать инструменты `node.*` (экран, камера, система) на вашей локальной машине через WebSocket Gateway.

Типичные настройки:

1. Запустите шлюз на постоянном хосте (VPS/домашний сервер).
2. Поместите хост шлюза + компьютер на тот же хвост.
3. Убедитесь, что шлюз WS является доступным (хвостовая связь или SSH туннель).
4. Откройте приложение macOS локально и подключитесь в режиме **Remote over SSH** (или через прямой tailnet),
   чтобы оно могло зарегистрироваться как узел.
5. Одобрить узел на шлюзе:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Не требуется отдельный TCP мост; узлы соединяются через шлюз WebSocket.

Напоминание о безопасности: соединение узла macOS позволяет `system.run` на этой машине. Только
пары устройств, которым вы доверяете, и обзор [Security](/gateway/security).

Доки: [Nodes](/nodes), [Протокол шлюза](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale подключен, но я не получаю ответов, что сейчас

Проверьте базовые данные:

- Шлюз запущен: `openclaw gateway status`
- Здоровье шлюза: `openclaw status`
- Здоровье канала: статус каналов openclaw

Затем проверьте авторизацию и маршрутизацию:

- Если вы используете сервер Tailscale Serve, убедитесь, что `gateway.auth.allowTailscale` установлен правильно.
- Если вы подключаетесь через SSH туннель, то подтвердите что локальный туннель находится вверх и указывает на нужный порт.
- Подтвердите вашу учетную запись allowlists (DM или группу).

Документы: [Tailscale](/gateway/tailscale), [Удаленный доступ](/gateway/remote), [Channels](/channels).

### Позволяет вести разговор двух экземпляров OpenClaw друг с другом локального VPS

Да. Встроенного моста «бот-к-боту» нет, но вы можете настроить его несколькими
надёжными способами:

**Simplest:** использовать обычный чат канал для обоих ботов может получить доступ (Telegram/Slack/WhatsApp).
Бот A пошлет сообщение боту В, а затем позвольте боту Б ответить как обычно.

**CLI мост (обобщенный):** запустите скрипт, который вызывает другой шлюз с помощью
`openclaw agent --message ... --deliver`, нацеливая его на чат, где другой бот
слушает. Если один бот находится на удаленном VPS, укажите ваш CLI на этот удаленный шлюз
через SSH/Tailscale (см. [Удаленный доступ](/gateway/remote)).

Пример шаблона (запуск с машины, которая может достичь целевого шлюза):

```bash
openclaw агент --message "Привет от локального бота" --deliver --channel telegram --reply-to <chat-id>
```

Совет: добавьте ограничитель, чтобы два бота не зацикливались бесконечно (только упоминания, белые списки каналов
или правило «не отвечать на сообщения ботов»).

Документы: [Удаленный доступ](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Нужно отделить VPS от нескольких агентов

Нет. Один шлюз может размещать несколько агентов, каждый со своим собственным рабочим пространством, по умолчанию моделей,
и маршрутизацией. Это нормальная настройка, и она гораздо дешевле и проще, чем запуск
по одному VPS на одного агента.

Используйте отдельные VPN только тогда, когда вам нужна жесткая изоляция (границы безопасности) или очень
различные конфигурации, которые вы не хотите делиться. В противном случае оставьте один Gateway и
используйте несколько агентов или субагентов.

### Есть возможность использовать узел на моем персональном ноутбуке вместо SSH от VPS

Да, узлы - это первоклассный способ связаться с вашим ноутбуком из удаленного шлюза и
разблокировать больше, чем доступ к оболочке. Шлюз работает на macOS/Linux (Windows via WSL2) и
легким весом (маленький ящик для VPS или Raspberry Pi-class отлично; 4 ГБ ОЗУ очень много), поэтому обычная настройка* это обычный хост, плюс ваш ноутбук в качестве узла.

- **Входящее SSH не требуется.** Узлы подключаются к WebSocket шлюза и используют подключение к устройству.
- **Более безопасные контрольные параметры.** `system.run` закрыт узлами allowlists/approvals на этом ноутбуке.
- **Больше утилит.** Узлы открывают `canvas`, `camera` и `screen`, кроме `system.run`.
- \*\*Локальная автоматизация браузера. \* Держите шлюз в VPS, но запустите Chrome локально и ретрансляцию
  с расширением Chrome + узлом на ноутбуке.

SSH отлично подходит для доступа к ad-hoc оболочке, но узлы проще для текущих рабочих процессов агента и автоматизации
устройств.

Документы: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Расширение Chrome](/tools/chrome-extension).

### Если я устанавливаю на второй ноутбук или просто добавляю узел

Если вам нужны только **локальные инструменты** (экран/камера/экзекс) на втором ноутбуке, добавьте его в виде
**узла**. Это хранит один шлюз и позволяет избежать дублирования конфигурации. Инструменты локальных узлов являются
в настоящее время только macOS, но мы планируем распространить их на другие ОС.

Установите второй шлюз только тогда, когда вам нужна **жесткая изоляция** или два полностью отдельных бота.

Документы: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Несколько шлюзов](/gateway/multiple-gateways).

### Выполнять запуск службы шлюзов

Нет. Только **один шлюз** должен работать на каждом хосте, если вы не запускаете отдельные профили (смотрите [Несколько шлюзов](/gateway/multiple-gateways)). Узлы - это периферии, соединяющие
с шлюзом (iOS/Android узлов или macOS «режим узла» в меню). Список узлов без заголовков
узлов и CLI управления см. в [Node host CLI](/cli/node).

Полная перезагрузка необходима для изменений `gateway`, `discovery` и `canvasHost`.

### Есть ли API RPC способ применить конфигурацию

Да. `config.apply` проверяет + записывает полную конфигурацию и перезапускает шлюз как часть операции.

### configapply wiked my config How do I recover and avoid this

`config.apply` заменяет **всю конфигурацию**. Если вы отправляете частичный объект, все
остальное будет удалено.

Восстановление:

- Восстановление из резервной копии (git или скопированный `~/.openclaw/openclaw.json`).
- Если у вас нет резервной копии, перезапустите `openclaw doctor` и перенастройте каналы/модели.
- Если это было неожиданно, сообщите об ошибке и включите вашу последнюю известную конфигурацию или резервную копию.
- Локальный программный агент часто может перестроить рабочую конфигурацию из логов или истории.

Избегать:

- Используйте `openclaw config set` для небольших изменений.
- Используйте `openclaw configure` для интерактивных правок.

Документы: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Какая минимальная конфигурация для первой установки

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Это задает ваше рабочее пространство и ограничивает кто может вызвать бота.

### Как настроить Tailscale на VPS и подключаться с моего Mac

Минимальные шаги:

1. **Установить + войти в VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale
   ```

2. **Установите + войдите на Mac**
   - Используйте приложение Tailscale и войдите в ту же хвостовую сеть.

3. **Включить MagicDNS (рекомендуется)**
   - В консоли администратора Tailscale включите MagicDNS для VPS имеет стабильное имя.

4. **Используйте имя хоста в хэтнете**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xx.ts.net:18789`

Если вы хотите интерфейс управления без SSH, используйте сервер Tailscale в VPS:

```bash
openclaw gateway --tailscale serve
```

Это держит шлюз привязанный к циклу и открывает HTTPS по Tailscale. См. [Tailscale](/gateway/tailscale).

### Как подключить узел Mac к удаленному серверу Tailscale шлюза

Сервис открывает **интерфейс управления шлюзом + WS**. Узлы подключаются через ту же конечную точку Gateway WS.

Рекомендуемые настройки:

1. **Убедитесь, что VPS + Mac находятся на той же хвостуте**.
2. **Используйте приложение macOS в удаленном режиме** (цель SH может быть имя хоста по умолчанию).
   Приложение будет туннелировать порт шлюза и подключаться в качестве узла.
3. **Одобрите узел** на шлюзе:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Доки: [Протокол шлюза] (/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars и .env загрузка

### Как переменные окружения OpenClaw загружаются

OpenClaw читает переменные окружения из родительского процесса (shell, launchd/systemd, CI и т. п.) и дополнительно нагрузки:

- `.env` из текущего рабочего каталога
- глобальный fallback `.env` из `~/.openclaw/.env` (также известен как `$OPENCLAW_STATE_DIR/.env`)

Ни один файл `.env` не переопределяет уже существующие переменные окружения.

Вы также можете определить inline env vars в конфигурации (применяется только если отсутствует в env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

См. [/environment](/help/environment) для полного порядка приоритета и источников.

### Я начал шлюз через службу, и мои env vars исчезли, что теперь

Два общих исправления:

1. Поместите недостающие ключи в файл `~/.openclaw/.env`, так что они подобраны, даже если служба не наследует вашу оболочку.
2. Включить импорт оболочки (неудобство):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Это запускает вашу оболочку и импортирует только недостающие ожидаемые ключи (никогда не переопределится). Сырье эквивалентов:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Я установил COPILOTGITHUBTOKEN, но в состоянии модели показывается Shell env off Why

`openclaw models status` сообщает, что **shell env import** включен. "Shell env: off"
**не** означает, что ваши вары пропали - это просто означает, что OpenClaw не загрузит
вашу регистрационную оболочку автоматически.

Если шлюз работает как сервис (launchd/systemd), он не наследует окружение оболочки
. Исправить, выполнив одну из них:

1. Поместите токен в `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Или включите импорт оболочки (`env.shellEnv.enabled: true`).

3. Или добавьте его в конфигурационный блок `env` (только если он отсутствует).

Затем перезагрузите шлюз и проверьте:

```bash
openclaw models status
```

Скопилотные токены читаются из `COPILOT_GITHUB_TOKEN` (также `GH_TOKEN` / `GITHUB_TOKEN`).
См. [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

## Сессии и несколько чатов

### Как начать новую беседу

Отправьте `/new` или `/reset` в качестве отдельного сообщения. См. [Управление сессиями] (/concepts/session).

### Сбрасывать сессии автоматически, если я никогда не отправляю новых

Да. Сессии истекают после `session.idleMinutes` (по умолчанию **60**). Новое сообщение **следующее**
для этого ключа чата начинает новый идентификатор. Это не удаляет субтитры* он просто запускает новую сессию.

```json5
{
  сессия: {
    idleMinutes: 240,
  },
}
```

### Есть ли способ сделать команду OpenClaw одним генеральным директором и многими агентами

Да, с помощью **маршрутизации агентов** и **субагентов**. Вы можете создать одного координатора
и нескольких рабочих агентов с собственными рабочими пространствами и моделями.

Тем не менее, это лучше всего рассматривать как **веселый эксперимент**. Это требует много токенов и часто
менее эффективно, чем использование одного бота с отдельными сессиями. Типичная модель, которую мы
представляем, — это один бот, с которым вы общаетесь, и разные сессии для параллельной работы. Этот
бот также может при необходимости создавать субагентов.

Документы: [Маршрутизация нескольких агентов](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Компоненты CLI](/cli/agents).

### Почему контекст был усечен средней задачей Как мне предотвратить это

Контекст сессии ограничен окном модели. Длинные чаты, большие инструменты вывода или многие файлы
могут вызвать усечение или уплотнение.

Что помогает:

- Попросите бота обобщить текущее состояние и записать его в файл.
- Используйте `/compact` перед длинными задачами и `/new` при переключении тем.
- Сохраняйте важный контекст в рабочей области и попросите бота прочитать его обратно.
- Используйте подагенты для длительной или параллельной работы, чтобы основной чат остался меньше.
- Выберите модель с большим контекстным окном, если это происходит часто.

### Как мне полностью сбросить OpenClaw, но сохранить его

Используйте команду сброса:

```bash
openclaw reset
```

Неинтерактивный полный сброс:

```bash
openclaw reset --scope full --yes --non-interactive
```

Затем перезапустить на борту:

```bash
openclaw onboard --install-daemon
```

Notes:

- Мастер настройки также предлагает **Reset**, если он видит существующую конфигурацию. См. [Wizard](/start/wizard).
- Если вы использовали профили (`--profile` / `OPENCLAW_PROFILE`), сбросите каждый каталог состояния (по умолчанию `~/.openclaw-<profile>`).
- Сброс Dev: `openclaw gateway --dev --reset` (только dev-only; wipes dev config + credentials + sessions + workspace).

### Я получаю контекст слишком больших ошибок, как я могу сбросить или компактно

Используйте один из следующих вариантов:

- **Компактный** (позволяет вести разговор, но обобщает более старые ходы):

  ```
  /компактный
  ```

  или `/compact <instructions>` для руководства резюме.

- **Сбрось** (новый ID сеанса для одного и того же ключа чата):

  ```
  /new
  /reset
  ```

Если он продолжит происшествие:

- Включение или настройка **сессии pruning** (`agents.defaults.contextPruning`), чтобы обрезать старый вывод инструментов.
- Используйте модель с большим контекстным окном.

Документы: [Compaction](/concepts/compaction), [pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Почему я вижу, что запрос LLM отклонил сообщениеNcontentXtooluseinput Поле требуется

Это ошибка проверки провайдера: модель создала блок `tool_use` без требуемого
`input`. Обычно это означает, что история сессий устарела или повреждена (часто после длинных потоков
или изменения инструмента/схемы).

Исправлено: начать новую сессию с `/new` (отдельное сообщение).

### Почему я получаю сообщения от сердца каждые 30 минут

Heartbeats запускаются каждые **30м** по умолчанию. Настроить или отключить их:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // или "0m" для отключения
      },
    },
  },
}
```

Если `HEARTBEAT.md` существует, но фактически пуст (только пустые строки и
markdown‑заголовки вроде `# Heading`), OpenClaw пропускает запуск heartbeat,
чтобы сэкономить API‑вызовы.
Если файл отсутствует, сигнал keepalive всё равно выполняется, и модель сама решает, что делать.

Per-agent overrides use `agents.list[].heartbeat`. Документы: [Heartbeat](/gateway/heartbeat).

### Мне нужно добавить учетную запись бота в группу WhatsApp

Нет. OpenClaw работает на **своём аккаунте**, так что если вы в группе, OpenClaw видит его.
По умолчанию групповые ответы заблокированы до тех пор, пока вы не разрешите отправителям (`groupPolicy: "allowlist"`).

Если вы хотите, чтобы только **вы** могли срабатывать групповые ответы:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Как получить JID группы WhatsApp

Вариант 1 (самый быстрый): хвостите журналы и отправьте тестовое сообщение в группу:

```bash
openclaw журналы --follow --json
```

Ищите `chatId` (или `from`), заканчивая `@g.us`, как
`1234567890-1234567890@g.us`.

Вариант 2 (если он уже настроен/разрешен): список групп из конфигурации:

```bash
openclaw список групп директорий --channel whatsapp
```

Документы: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Почему OpenClaw не отвечает в группе

Две общие причины:

- Упоминание ворот включён (по умолчанию). Вы должны @mention бота (или соответствовать `mentionPatterns`).
- Вы настроили `channels.whatsapp.groups` без `*"`, и группа не может быть в списке.

См. [Groups](/channels/groups) и [Group messages](/channels/group-messages).

### Использовать групповые потоки для обмена контекстом с ЛС

По умолчанию чаты сворачиваются к основной сессии. Группа/каналы имеют свои собственные ключи сеансов, а темы Telegram / потоки Discord являются отдельными сессиями. См. [Groups](/channels/groups) и [Group messages](/channels/group-messages).

### Сколько рабочих мест и агентов я могу создать

Нет жестких ограничений. Десятки (даже сотни) хороши, но посмотрите:

- **Рост диска:** сеансы + транскрипты живут под `~/.openclaw/agents/<agentId>/sessions/`.
- **Стоимость токена:** больше агентов означает более одновременное использование модели.
- **Накладные операции:** профили авторизации для каждого агента, рабочие пространства и маршрутизация канала.

Советы:

- Сохранять одну **активную** рабочую область для каждого агента (`agents.defaults.workspace`).
- Очищать старые сессии (удалять записи JSONL или сохранять), если диск увеличивается.
- Используйте `openclaw doctor` чтобы обнаружить злые рабочие пространства и несоответствие профиля.

### Могу ли я запустить несколько ботов или чатов в то же время Slack и как я должен установить, что

Да. Используйте **Мульти-Маршрутизация Агентов** для запуска нескольких изолированных агентов и маршрутизации входящих сообщений
канала/аккаунта/пира. Slack поддерживается как канал и может быть связан с определенными агентами.

Доступ к браузеру — мощный инструмент, но это не «делать всё, что может человек»: антибот-защита, CAPTCHA и MFA
по-прежнему могут блокировать автоматизацию. Для наиболее надежного управления браузером используйте ретранслятор расширений Chrome
на машине, которая запускает браузер (и держите шлюз в любом месте).

Установка старой практики:

- Хост шлюза всегда (VPS/Mac mini).
- Один агент на одну роль (привязки).
- Канал(ы) Slack привязан к этим агентам.
- При необходимости локальный браузер через ретранслятор расширения (или узел).

Доки: [Маршрутизация нескольких агентов](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Расширение Chrome](/tools/chrome-extension), [Nodes](/nodes).

## Модели: по умолчанию, выбор, алиасы, переключение

### Что такое модель по умолчанию

Модель OpenClaw'а по умолчанию является всем, что вы установили как:

```
agents.defaults.model.primary
```

На модели ссылаются как на "провайдера/модель" (пример: "антропик/клаудо-opus-4-6"). Если вы не используете провайдера, в настоящее время OpenClaw считает `anthropic` временным резервным вариантом, но вы все еще **явно** установите `provider/model`.

### Какую модель вы рекомендуете

**Рекомендуется по умолчанию:** `anthropic/claude-opus-4-6`.
**Хорошая альтернатива:** `anthropic/claude-sonnet-4-5`.
**Надежный (меньший символ):** `openai/gpt-5.2` - почти так хорошо, как Опус, менее личность.
**Budget:** `zai/glm-4.7`.

У MiniMax M2.1 есть собственные документы: [MiniMax](/providers/minimax) и
[Локальные модели](/gateway/local-models).

Правило большого пальца: используйте **лучшую модель, которую можно найти** для работы с высокими ставками\*\* и более дешевую модель
для рутинных чатов или резюме. Вы можете маршрутизировать модели по агентам и использовать субагентов для
распараллеливания длительных задач (каждый субагент потребляет токены). См. [Models](/concepts/models) и
[Sub-agents](/tools/subagents).

Сильное предупреждение: более слабые/избыточные модели более уязвимы для подсказок
инъекций и небезопасного поведения. См. [Security](/gateway/security).

Больше контекста: [Models](/concepts/models).

### Могу ли я использовать модели с собственными серверами llamacpp vLLM Ollama

Да. Если ваш локальный сервер обнаруживает OpenAI-совместимый API, вы можете указать на него
своего поставщика. Олама поддерживается непосредственно и является самым простым путём.

Примечание по безопасности: более мелкие или сильно квантизированные модели более уязвимы к
prompt injection. Мы настоятельно рекомендуем **большие модели** для любого бота, который может использовать инструменты.
Если вы по-прежнему хотите небольшие модели, включите песочницу и строгие списки инструментов.

Доки: [Ollama](/providers/ollama), [Локальные модели](/gateway/local-models),
[Модели провайдеров](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Как переключать модели без удаления конфигурации

Используйте **команды модели** или отредактируйте только поля **модели**. Избегайте полной замены конфигурации.

Безопасные опции:

- `/модель` в чате (быстрый, персиковый)
- `openclaw модели, набор ...` (обновляет только конфигурацию модели)
- `openclaw configure --section model` (интерактивный)
- редактируйте `agents.defaults.model` в файле `~/.openclaw/openclaw.json`

Избегайте `config.apply` с частичным объектом, если не хотите заменить конфигурацию целиком.
Если вы перезаписать конфигурацию, восстановите из резервной копии или перезапустите `openclaw doctor` для восстановления.

Документы: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Что такое OpenClaw, Flawd, и Krill используют для моделей

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) — см. [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Как переключать модели на лету без перезапуска

Используйте команду `/model` в качестве отдельного сообщения:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Вы можете перечислить доступные модели с помощью `/model`, `/model list`, или `/model status`.

`/model` (и `/model list`) показывает компактный выбор с нумерованными номерами. Выберите по номеру:

```
/модель 3
```

Вы также можете принудительно использовать профиль авторизации для провайдера (по сессиям):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Совет: `/model status` показывает какой агент является активным, какой файл `auth-profiles.json` используется, и какой профиль авторизации будет опробован далее.
Она также показывает настроенную конечную точку провайдера (`baseUrl`) и режим API (`api`), когда доступно.

**Как открепить профиль с профилем**

Перезапустите `/model` **без** суффикс `@profile`:

```
/модель антропических/клаудо-opus-4-6
```

Если вы хотите вернуться к настройкам по умолчанию, выберите его из `/model` (или отправьте `/model <default provider/model>`).
Используйте `/model status` для подтверждения, какой профиль авторизации активен.

### Можно использовать GPT 5.2 для ежедневных задач, и Codex 5.3 для программирования

Да. Установить один в качестве по умолчанию и переключатель в случае необходимости:

- **Быстрый переключатель (по сессии):** `/model gpt-5.2` для ежедневных задач, `/model gpt-5.3-codex` для программирования.
- **По умолчанию + переключатель:** при кодировании установите `agents.defaults.model.primary` на `openai/gpt-5.2`, затем переключитесь на `openai-codex/gpt-5.3-codex` (или наоборот).
- **Подагенты:** задачи кодирования маршрута субагентам с другой моделью по умолчанию.

См. [Models](/concepts/models) и [Slash команды](/tools/slash-commands).

### Почему я вижу модель не разрешена, а затем нет ответа

Если задан `agents.defaults.models`, он становится **белым списком** для `/model` и любых
переопределений сессий. Выбор модели, которой нет в этом списке:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Эта ошибка возвращается \*\*вместо обычного ответа. Исправление: добавьте модель в
`agents.defaults.models`, уберите белый список или выберите модель из `/model list`.

### Почему я вижу неизвестную модель минимальной минимальной

Это означает, что **провайдер не настроен** (конфигурация MiniMax провайдера или авторизация
профиля были найдены), поэтому модель не может быть решена. Исправление для этого обнаружения находится
в **2026.1.12** (на момент написания не выпущено).

Исправить чек-список:

1. Обновите до **2026.1.12** (или запустите `main`), затем перезапустите шлюз.
2. Убедитесь, что MiniMax настроен (мастер или JSON), или что ключ API MiniMax
   существует в профилях env/auth, чтобы провайдер мог быть установлен.
3. Используйте точный id модели (чувствительный к регистру): `minimax/MiniMax-M2.1` или
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   и выберите из списка (или `/model list` в чате).

См. [MiniMax](/providers/minimax) и [Models](/concepts/models).

### Могу ли я использовать MiniMax как стандартный и OpenAI для сложных задач

Да. Используйте **MiniMax в качестве по умолчанию** и переключайте **на сессию** в случае необходимости.
Fallbackback - **ошибки**, а не "сложные задачи", поэтому используйте `/model` или отдельного агента.

**Опция А: переключение на сессию**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      модели: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Затем:

```
/модель gpt
```

**Вариант В: отдельные сотрудники**

- Агент A по умолчанию: MiniMax
- Агент B по умолчанию: OpenAI
- Маршрут по агенту или используйте `/agent` для переключения

Документы: [Models](/concepts/models), [Маршрутизация нескольких агентов](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Ярлыки opus sonnet gpt встроенные

Да. OpenClaw поставляет несколько сокращений по умолчанию (применяется только тогда, когда модель существует в `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Если вы устанавливаете свои собственные псевдонимы с одинаковым именем, то выигрывает ваше значение.

### Как определить сочетания ярлыков для модели

Псевдонимы получены от `агентов.defaults.models.<modelId>.alias`. Пример:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      модели: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Затем `/model sonnet` (или `/<alias>`, когда поддерживается) передается идентификатору этой модели.

### Как добавлять модели от других провайдеров, таких как OpenRouter или ZAI

OpenRouter (платный токен; много моделей):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      модели: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (ГЛМ):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      модели: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Если вы ссылаетесь на провайдера/модель, но требуемый ключ провайдера отсутствует, вы получите ошибку аутентификации во время выполнения (e. `Не найден ключ API для поставщика "zai"`).

**Не найден API ключ для провайдера после добавления нового агента**

Обычно это означает, что у **нового агента** есть пустой магазин авторизации. Аутентификация выполняется для каждого агента и
хранится в:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Варианты исправления:

- Запустите `openclaw agents add <id>` и настройте auth во время мастера.
- Или скопируйте `auth-profiles.json` из `agentDir` главного агента в новый каталог `agentDir`.

**Не** повторно используйте `agentDir` в разных агентах; это вызывает коллизию авторов/сеансов.

## Неисправность модели и «Все модели не выполнены»

### Как работают отказы

Отказ происходит в течение двух этапов:

1. **Автоповорот профиля** внутри одного и того же провайдера.
2. **Fallback модели** к следующей модели в `agents.defaults.model.fallbacks`.

Перегрузки применяются к сбоям профилей (экспоненциальный backoff), так что OpenClaw может отвечать даже в тех случаях, когда провайдер ограничен или временно не работает.

### Что означает эта ошибка

```
Не найдено учетных данных для профиля "anthropic:default"
```

Это означает, что система попыталась использовать идентификатор профиля авторизации `anthropic:default`, но не смогла найти учетные данные для него в магазине ожидаемой аутентификации.

### Исправлен чек-лист без учётных данных для антропика профиля

- **Подтвердите, где живут профили авторизации** (новые и устаревшие пути)
  - Текущий: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (перенесено `openclaw doctor`)
- **Подтвердите, что ваш env var загружен шлюзой**
  - Если вы установите `ANTHROPIC_API_KEY` в оболочке, но запустите шлюз через systemd/launchd, он не может наследовать его. Поместите его в `~/.openclaw/.env` или включите `env.shellEnv`.
- **Убедитесь, что вы редактируете агента правильно**
  - Многоагентная настройка означает, что файл `auth-profiles.json` может быть несколько файлов.
- **Модель проверки состояния безопасности/авторизации**
  - Используйте `openclaw models status`, чтобы увидеть настроенные модели и аутентифицировать ли провайдеры.

**Исправьте контрольный список учетных данных для антропии профиля**

Это означает, что запуск привязан к профилю аутентификации Anthropic, но Gateway
не может найти его в своём хранилище аутентификации.

- **Используйте токен установки**
  - Запустите `claude setup-token`, затем вставьте его с помощью `openclaw models auth setup-token --provider anthropic`.
  - Если токен был создан на другой машине, используйте `openclaw models auth paste-token --provider anthropic`.

- **Если вы хотите использовать ключ API**
  - Поместите `ANTHROPIC_API_KEY` в `~/.openclaw/.env` на **шлюз**.
  - Очистить прикрепленный порядок, который заставляет пропущенный профиль:

    ```bash
    ордер openclaw очищает антропический ключ --provider
    ```

- **Подтвердите выполнение команд на хосте шлюза**
  - В удаленном режиме профили авторизации живут на шлюзной машине, а не на ноутбуке.

### Почему он также пытался Google Gemini и потерпел неудачу

Если ваша модель включает Google Gemini в качестве запасного (или вы переключились на короткий Gemini), OpenClaw попытается сделать это во время падения модели. Если вы не настроили учетные данные Google, вы увидите `Нет API ключа для провайдера "google"`.

Исправлено: либо предоставить Google auth, либо удалить/избежать моделей Google в `agents.defaults.model.fallbacks` / псевдонимы, так что резервного пути не существует.

**LLM запрос отклонил подпись мышления сообщения необходимой антигравитацией Google**

Причина: история сессии содержит **блоки мышления без подписей** (часто из
прерванные/частичные потоки). Google Antigravity требует подписи для блоков мышления.

Исправлено: OpenClaw теперь полос неподписанными блоками мышления для Google Antigravity Claude. Если всё ещё появляется, начните **новую сессию** или установите `/thinking off` для этого агента.

## Профили авторизации: что они и как управлять ими

Связанный: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### Что такое профиль авторизации

Аутентификационный профиль - это именная учетная запись (OAuth или API ключ), привязанная к провайдеру. Профили в режиме онлайн в:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Что такое типичные ID профиля

OpenClaw использует идентификаторы провайдеров-префиксов типа

- `anthropic:default` (обычно когда нет идентификатора электронной почты)
- `anthropic:<email>` для OAuth-идентификаторов
- выбранные вами ID (например, `anthropic:work`)

### Могу ли я контролировать, какой авторизованный профиль пробован сначала

Да. Конфигурация поддерживает необязательные метаданные для профилей и заказа на провайдера (`auth.order.<provider>`). Это **не** хранит секреты, он сопоставляет идентификаторы с провайдером/режимом и устанавливает порядок вращения.

OpenClaw может временно пропустить профиль, если он находится в **откате** (ограничение по времени/откаты/откаты авторизации) или более длиннее **отключено** (счет/недостаточность кредитов). Чтобы проверить это, запустите `openclaw models status --json` и проверьте `auth.unusableProfiles`. Tuning: \`auth.cooldowns.billingBackoffHours\*.

Вы также можете установить переопределение порядка **для агента** (хранится в `auth-profiles.json`) через CLI:

```bash
# По умолчанию настроенный агент по умолчанию (omit --agent)
openclaw models auth order get --provider anthropic

# Блокировать вращение в один профиль (только в другом)
модели порядка авторизации --provider anthropic anthropic:default

# Или установить явный порядок (fallback within provider)
openclaw models set auth order set --provider anthropic:work anthropic:default

# Очистить переопределение (back to config auth. rder / round-robin)
порядок аутентификации моделей openclaw очистить --provider anthropic
```

Для цели определенного агента:

```bash
openclaw модели порядка авторизации задают --provider anthropic --agent main anthropic:default
```

### OAuth vs API ключ в чем разница

OpenClaw поддерживает и то и другое:

- **OAuth** часто использует доступ к подписке (если это применимо).
- **API keys** использует оплату по токену.

Мастер явно поддерживает Anthropic setup-token и OpenAI Codex OAuth и может хранить ключи API.

## Шлюз: порты, "уже запущенные" и удаленный режим

### Какой порт использует шлюз

`gateway.port` управляет одним мультиплексированным портом для WebSocket + HTTP (Control UI, hooks, etc.).

Приоритеты:

```
--port > OPENCLAW_GATEWAY_PORT > шлюз > по умолчанию 18789
```

### Почему статус шлюза openclaw говорит о том, что Runtime запущен, но пробка RPC не удалась

Поскольку "running" это **руководитель** просмотр (launchd/systemd/schtasks). Probe RPC является CLI на самом деле подключается к шлюзу WebSocket и вызову `status`.

Используйте `openclaw gateway status` и доверяйте этим строкам:

- `Probe target:` (URL-адрес, который фактически использован)
- `Слушать:` (что на самом деле связано с портом)
- `Последняя ошибка шлюза:` (обычная причина, когда процесс жив, но порт не обрабатывается)

### Почему статус openclaw шлюза показывает конфигурационные cli и Конфигурационный сервис

Вы редактируете один конфигурационный файл, пока служба запущена другой (часто не совпадает `--profile` / `OPENCLAW_STATE_DIR`).

Исправление:

```bash
установка шлюза openclaw --force
```

Запустите это из того же `--profile` / среды, которую вы хотите использовать службу.

### Что означает другой экземпляр шлюза уже прослушивание

OpenClaw вводит блокировку рабочего времени путем немедленной привязки WebSocket к серверу при запуске (по умолчанию `ws://127.0.0.1:18789`). Если привязка проваливается с помощью `EADDRINUSE`, она выводит `GatewayLockError`, указывающий на другой экземпляр, уже слушается.

Исправлено: остановить другой экран, освободите порт или запустите с помощью шлюза `openclaw --port <port>`.

### Как запустить OpenClaw в удаленном режиме клиент подключается к шлюзу в другом месте

Установите `gateway.mode: "remote"` и укажите URL удалённого WebSocket, при необходимости с токеном/паролем:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Notes:

- `openclaw gateway` запускается только тогда, когда `gateway.mode` является `local` (или вы пропустили флаг переопределения).
- Приложение macOS следит за конфигурационным файлом и переключает режимы в реальном времени при изменении этих значений.

### Панель управления говорит о несанкционированном доступе или переподключается, что сейчас

Ваш шлюз запущен с включенной авторизацией (`gateway.auth.*`), но пользовательский интерфейс не отправляет соответствующий токен/пароль.

Факты (из кода):

- В Control UI хранится токен в браузере localStorage `openclaw.control.settings.v1`.

Исправление:

- Быстрей: `openclaw dashboard` (печатает + копирует URL панели инструментов, пытается открыть; показывает SSH хинт, если заголовка).
- Если у вас еще нет фишки: `openclaw doctor --generate-gateway-token`.
- Если удалент, сначала туннель: `ssh -N -L 18789:127.0.0.1:18789 user@host` затем откройте `http://127.0.0.1:18789/`.
- Установите `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`) на шлюзе хоста.
- В настройках Панели управления вставьте тот же токен.
- Всё ещё застряли? Запустите `openclaw status --all` и следуйте за [Troubleshooting](/gateway/troubleshooting). Смотрите [Dashboard](/web/dashboard) для деталей авторизации.

### Я установил шлюз (gatewaybind tailnet, но он не связывает ничего не слушает

`tailnet` выбирает IP из Tailscale вашего сетевого интерфейса (100.64.0.0/10). Если машина не на Tailscale (или интерфейс не работает), то связывать нечего.

Исправление:

- Запускать Tailscale на этом хосте (таким образом у него 100.x адрес), или
- Переключиться на `gateway.bind: "loopback"` / `lan`.

Примечание: `tailnet` is explicit. `auto` предпочитает loopback; используйте `gateway.bind: "tailnet"`, когда вы хотите привязку только для tailnet.

### Могу ли я запустить несколько шлюзов на одном хосте

Обычно ни один шлюз не может запускать несколько каналов обмена сообщениями и агентов. Используйте несколько шлюзов только тогда, когда вам нужна избыточность (например, спасательный бот) или жесткая изоляция.

Да, но вы должны изолировать:

- `OPENCLAW_CONFIG_PATH` (конфигурация для каждого экземпляра)
- `OPENCLAW_STATE_DIR` (состояние на экземпляр)
- `agents.defaults.workspace` (изоляция рабочей области)
- `gateway.port` (уникальные порта)

Быстрая установка (рекомендуется):

- Используйте `openclaw --profile <name> …` на экземпляр (автосоздание `~/.openclaw-<name>`).
- Установите уникальный `gateway.port` в каждой конфигурации профиля (или передайте `--port` для ручного запуска).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Профили также суффиксные имена служб (`bot.molt.<profile>`; старое `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Полное руководство: [Несколько Gateway](/gateway/multiple-gateways).

### Что означает неверный код рукопожатия 1008

Шлюз - **WebSocket сервер** и ожидает, что
будет `connect` кадром. 1. Если он получает что‑то другое, он закрывает соединение
с **кодом 1008** (нарушение политики).

Распространённые причины:

- Вы открыли URL-адрес **HTTP** в браузере (`http://...`) вместо WS клиента.
- Вы использовали неправильный порт или путь.
- Прокси или туннель разделяют авторизацию или отсылают не входящий в Шлюз запрос.

Быстрые исправления:

1. Используйте WS URL: `ws://<host>:18789` (или `wss://...` если HTTPS).
2. Не открывать WS порт во вкладке обычный браузер.
3. Если включена авторизация, укажите токен/пароль в окне `connect`.

Если вы используете CLI или TUI, URL-адрес должен выглядеть так:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Подробности протокола: [Протокол Gateway](/gateway/protocol).

## Ведение журнала и отладка

### Где журналы

Журналы (структура):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Вы можете установить стабильный путь через `logging.file`. Уровень журнала файлов контролируется `logging.level`. Достоверность консоли контролируется `--verbose` и `logging.consoleLevel`.

Самый быстрый хвост журнала:

```bash
openclaw logs --follow
```

Логи сервиса/руководителя (при запуске шлюза через запуска/систему):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` и `gateway.err.log` (по умолчанию: `~/.openclaw/logs/...`; в профилях используется `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

2. См. [Troubleshooting](/gateway/troubleshooting#log-locations) для получения дополнительной информации.

### Как запускать шлюз

Использовать шлюзовые помощники:

```bash
статус шлюза openclaw
перезапуск шлюза openclaw
```

Если вы запускаете шлюз вручную, `openclaw gateway --force` может запросить порт. См. [Gateway](/gateway).

### Я закрыл свой терминал на Windows, как я могу перезапустить OpenClaw

Существует **два режима установки Windows**:

**1) WSL2 (рекомендуется):** Шлюз работает внутри Linux.

Откройте PowerShell, введите WSL, затем перезапустите:

```powershell
wsl
Openclaw статус
перезапуск шлюза openclaw
```

Если вы никогда не устанавливали сервис, запустите его на переднем плане:

```bash
openclaw gateway run
```

**2) Родной Windows (не рекомендуется):** Шлюз работает непосредственно в Windows.

Открыть PowerShell и запустить:

```powershell
статус шлюза openclaw
перезапуск шлюза openclaw
```

Если вы запускаете его вручную (без сервиса), используйте следующее:

```powershell
openclaw gateway run
```

Документы: [Windows (WSL2)](/platforms/windows), [Runbook of Gateway](/gateway).

### Шлюз заканчивается, но ответы никогда не приходят, что я должен проверить

Начните с быстрой очистки здоровья:

```bash
статус openclaw
статус модели openclaw
статус каналов openclaw
журналы открытия --follow
```

Распространённые причины:

- Модель авторизации не загружена на **хосте шлюза** (проверьте `models status`).
- Привязка к каналу/разрешительный список ответов (проверьте настройки канала + журналы).
- WebChat/Dashboard открыта без правой фишки.

Если вы удалены, подтвердите соединение туннеля/масштабирование и что
шлюз WebSocket доступен.

Документы: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Отключено от шлюза нет причин, что сейчас

Это обычно означает, что пользовательский интерфейс потерял WebSocket-соединение. Проверьте:

1. Запущен ли шлюз? `openclaw gateway status`
2. Является ли шлюз здоровым? `openclaw status`
3. Имеет ли пользовательский интерфейс правильный токен? `openclaw dashboard`
4. Если пульт удален, является ли он туннелем/хвостовым масштабом?

Затем хвостовые журналы:

```bash
openclaw logs --follow
```

Документы: [Dashboard](/web/dashboard), [Удаленный доступ](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands не работает с сетевыми ошибками, Что я должен проверить

Начните с логов и статуса канала:

```bash
статус каналов openclaw
записи каналов openclaw --channel telegram
```

Если вы используете VPS или прокси, подтвердите разрешение исходящего HTTPS и работу DNS сервера.
Если шлюз удален, убедитесь, что вы ищете логин на хосте шлюза.

Документы: [Telegram](/channels/telegram), [Проблемы с каналами](/channels/troubleshooting).

### TUI не показывает вывод Что я должен проверить

Сначала подтвердите доступность шлюза, и агент может запускать:

```bash
статус openclaw
статус модели openclaw
журналы openclaw --follow
```

В TUI используйте `/status`, чтобы увидеть текущее состояние. Если вы ожидаете ответов в чате
канал, убедитесь, что доставка включена (`/deliver on`).

Документы: [TUI](/web/tui), [Slash команды](/tools/slash-commands).

### Как мне полностью остановить, а затем начать шлюз

Если вы установили сервис:

```bash
3. openclaw gateway stop
openclaw gateway start
```

Это останавливает/запускает **контролируемую службу** (запуск macOS, systemd в Linux).
Используйте это, когда шлюз запускается в фоновом режиме как демон.

Если вы работаете в фоновом режиме, тогда остановитесь на Ctrl-C тоже:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### Шлюз ELI5 открытый шлюз vs openclaw

- `openclaw gateway restart`: перезапускает **background service** (launchd/systemd).
- `openclaw gateway`: запускает шлюз **на переднем плане** для этого терминального сеанса.

Если вы установили службу, используйте команды шлюза. Используйте `openclaw gateway` когда
вы хотите одноразовый передний запуск.

### Что такое самый быстрый способ получения более подробной информации, когда что-то не удаётся

Запустите шлюз с помощью `--verbose`, чтобы получить больше деталей консоли. Затем проверите лог файл для автора, моделирования маршрутизации и RPC ошибок.

## Медиа и вложения

### Мой навык создал imagePDF, но ничего не было отправлено

Исходящие вложения от агента должны включать строку «MEDIA:<path-or-url>» (на собственной строке). См. [Настройка помощника OpenClaw](/start/openclaw) и [Отправка Агента](/tools/agent-send).

Отправка CLI:

```bash
отправка сообщения openclaw --target +15555550123 --message "Тут" --media /path/to/file.png
```

Также проверьте:

- Целевой канал поддерживает исходящий медиафайл и не заблокирован allowlists.
- Файл находится в пределах допустимого размера (размер изображения не превышает 2048px).

4. См. [Images](/nodes/images).

## Безопасность и контроль доступа

### Безопасно ли выявлять OpenClaw для входящих СМС

Считать входящие ЛС ненадежными входами. По умолчанию сконструированы для уменьшения риска:

- Поведение по умолчанию на каналах с поддержкой DM: **синхронизация**:
  - Неизвестные отправители получают код подключения; бот не обрабатывает их сообщения.
  - Утвердить с: \`openclaw approve <channel> <code>
  - Отложенные запросы ограничены по **3 на канал**; проверьте `openclaw список сопряжений <channel>`, если не прибыл код.
- Открытие СМС публично требует явного opt-in (`dmPolicy: "open"` и allowlist `"*"`).

Запустите `openclaw doctor` для поверхностной опасной политики ТМ.

### Быстрая инъекция только для публичных ботов

Нет. Инъекции подсказок — это **ненадежное содержимое**, а не просто кто умеет работать с ботом.
5. Если ваш ассистент читает внешний контент (веб‑поиск/загрузка, страницы браузера, электронную почту,
документы, вложения, вставленные логи), этот контент может содержать инструкции,
которые пытаются захватить управление моделью. Это может произойти, даже если **вы единственный отправитель**.

Наибольший риск связан с включением инструментов: модель может быть запущена в контекст
экстрафильтрации или вызова инструментов от вашего имени. Уменьшайте радиус поражения:

- с помощью "только для чтения" или "инструмент для отключения" агента для обобщения ненадежного контента
- сохранение `web_search` / `web_fetch` / `browser` для агентов с поддержкой инструментов
- «песочница» и строгие списки инструментов

Подробности: [Security](/gateway/security).

### Если у моего бота есть свой e-mail аккаунт на GitHub или номер телефона

Да, для большинства настроек. Изоляция бота с отдельными аккаунтами и номерами телефонов
снижает радиус обработки, если что-то пойдёт не так. 6. Это также упрощает ротацию
учётных данных или отзыв доступа без влияния на ваши личные аккаунты.

Начать маленький. 7. Предоставляйте доступ только к тем инструментам и аккаунтам, которые вам действительно нужны, и при необходимости
расширяйте его позже.

Документы: [Security](/gateway/security), [Pairing](/channels/pairing).

### Могу ли я дать ему автономию по отношению к моим текстовым сообщениям и это безопасно

Мы **не рекомендуем** полную автономию над личными сообщениями. Самый безопасный шаблон:

- Сохраняйте ЛС в **режиме сопряжения** или в жестком списке.
- Используйте **отдельный номер или счет**, если хотите отправить сообщение от вашего имени.
- Дайте черновик, затем **одобрите перед отправкой**.

Если вы хотите экспериментировать, сделайте это на выделенной учетной записи и держать ее изолированной. 8. См.
[Security](/gateway/security).

### Могу ли я использовать более дешевые модели для личных задач

Да, **если** агента только в чате, и на вводе будет надежно. 9. Младшие уровни
более уязвимы к перехвату инструкций, поэтому избегайте их для агентов с инструментами
или при чтении недоверенного контента. 10. Если вам всё же необходимо использовать меньшую модель, жёстко ограничьте
инструменты и запускайте её в песочнице. 11. См. [Security](/gateway/security).

### Я бежал в Telegram, но не получил код сопряжения

12. Коды сопряжения отправляются **только** тогда, когда неизвестный отправитель пишет боту и
    включён параметр `dmPolicy: "pairing"`. Сам по себе `/start` не генерирует код.

Проверить ожидающие запросы:

```bash
openclaw pairing list telegram
```

Если вы хотите немедленно получить доступ, разрешите свой идентификатор отправителя или установите `dmPolicy: "open"`
для этого аккаунта.

### WhatsApp сообщит моим контактам Как работает сопряжение

Нет. Политика WhatsApp по умолчанию **парация**. Неизвестные отправители получают только код сопряжения, и их сообщение **не обрабатывается**. Ответ OpenClaw только на чаты, которые он получает или явно посылает вам.

Подтвердить сопряжение с:

```bash
openclaw pairing approve whatsapp <code>
```

Список ожидающих запросов:

```bash
openclaw pairing list whatsapp
```

Телефонная подсказка мастера: используется для установки **allowlist/owner**, так что разрешены ваши собственные ЛН. Он не используется для автоотправки. Если вы используете ваш личный номер WhatsApp, используйте этот номер и включите `channels.whatsapp.selfChatMode`.

## Чат команд, отмена задач и "не останавливается"

### Как остановить отображение внутренних системных сообщений в чате

13. Большинство внутренних сообщений или сообщений инструментов отображаются только тогда, когда для этой сессии
    включены **verbose** или **reasoning**.

Исправьте в чате, где вы его видели:

```
/verbose off
/reasoning off
```

14. Если сообщений всё ещё слишком много, проверьте настройки сессии в Control UI и установите verbose
    в значение **inherit**. Подтвердите, что вы не используете профиль бота с `verboseDefault` установите
    на `on` в config.

Документы: [мышление и слова](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Как остановить текущую задачу

Отправить любое из этих **в качестве отдельного сообщения** (без слеша):

```
остановить
abort
esc
wait
exit

```

Это прерывание триггера (не команды слэш).

Для фоновых процессов (из exec инструмента), вы можете попросить агента выполнить:

```
процесс действия:kill sessionId:XXX
```

Обзор команд: см. [Slash команды](/tools/slash-commands).

Большинство команд должны быть отправлены как **standalone** сообщение, начинающееся с `/`, но несколько ярлыков (например, `/status`) также работают в очереди для отправителей allowlisted senders.

### Как отправить Discord сообщение от Telegram Crosscontext запрещено

OpenClaw блокирует **кросс-провайдеры** сообщений по умолчанию. Если вызов инструмента связан с
в Telegram, он не будет отправляться в Discord, если вы явно не разрешите его.

Включить обмен сообщениями между провайдерами для агента:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            маркер: { включен: true, префикс: "[от {channel}]" },
          },
        },
      },
    },
  },
}
```

Перезапустите шлюз после редактирования конфигурации. Если вы хотите это только для одного агента
, установите его в `agents.list[].tools.message`.

### Почему бот игнорирует сообщения о стремительном пожаре

Режим очереди контролирует взаимодействие новых сообщений в полете. Используйте `/queue` для изменения режимов:

- `steer` - новые сообщения перенаправляют текущую задачу
- `followup` - запускайте сообщения по одному за раз
- `collect` - пакетные сообщения и ответ один раз (по умолчанию)
- `steer-backlog` - steer now, затем обрабатывать бэклог
- `прервать` - прервать текущий запуск и начать свежим

Вы можете добавить опции, такие как `debounce:2s cap:25 drop:summarize` для последующих режимов.

## Ответьте на вопрос из журнала скриншот/чата

**В: "Что такое модель по умолчанию для антропии с ключом API?"**

**О:** В OpenClaw учетные данные и выбор моделей отдельны. Установка `ANTHROPIC_API_KEY` (или хранение ключа Anthropic API в профилях авторизации) позволяет аутентификацию, но фактическая модель по умолчанию является всем, что вы настраиваете в `Agents. efaults.model.primary` (например, `anthropic/claude-sonnet-4-5` или `anthropic/claude-opus-4-6`). Если вы видите `Отсутствуют учетные данные для профиля "anthropic:default"`, это означает, что шлюз не может найти данные для антропических профилей в ожидаемых `auth-профилях. son` для агента, который запущен.

---

Всё ещё застряли? Спросите в [Discord](https://discord.com/invite/clawd) или откройте [обсуждение на GitHub](https://github.com/openclaw/openclaw/discussions).
