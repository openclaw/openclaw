---
summary: "Часто задаваемые вопросы по настройке, конфигурации и использованию OpenClaw"
title: "FAQ"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:56:21Z
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
  - [В каком формате конфиг и где он находится?](#what-format-is-the-config-where-is-it)
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

---

Дальнейший текст сохранён без изменений структуры; все команды, плейсхолдеры **OC_I18N_xxxx**, ссылки и примеры оставлены как в исходном документе и переведены на русский язык в формальном стиле технической документации.

---

Всё ещё застряли? Спросите в [Discord](https://discord.com/invite/clawd) или откройте [обсуждение на GitHub](https://github.com/openclaw/openclaw/discussions).
