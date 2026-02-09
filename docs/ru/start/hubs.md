---
summary: "Хабы, которые ссылаются на каждую документацию OpenClaw"
read_when:
  - Вам нужна полная карта документации
title: "Хабы документации"
---

# Хабы документации

<Note>
Если вы новичок в OpenClaw, начните с [Начало работы](/start/getting-started).
</Note>

Используйте эти хабы, чтобы найти каждую страницу, включая углублённые материалы и справочную документацию, которые не отображаются в левом меню навигации.

## Начните здесь

- [Индекс](/)
- [Начало работы](/start/getting-started)
- [Быстрый старт](/start/quickstart)
- [Онбординг](/start/onboarding)
- [Мастер](/start/wizard)
- [Настройка](/start/setup)
- [Панель управления (локальный Gateway (шлюз))](http://127.0.0.1:18789/)
- [Справка](/help)
- [Каталог документации](/start/docs-directory)
- [Конфигурация](/gateway/configuration)
- [Примеры конфигурации](/gateway/configuration-examples)
- [Ассистент OpenClaw](/start/openclaw)
- [Витрина](/start/showcase)
- [Лор](/start/lore)

## Установка и обновления

- [Docker](/install/docker)
- [Nix](/install/nix)
- [Обновление / откат](/install/updating)
- [Рабочий процесс Bun (экспериментально)](/install/bun)

## Базовые концепции

- [Архитектура](/concepts/architecture)
- [Возможности](/concepts/features)
- [Сетевой хаб](/network)
- [Среда выполнения агента](/concepts/agent)
- [Рабочее пространство агента](/concepts/agent-workspace)
- [Память](/concepts/memory)
- [Цикл агента](/concepts/agent-loop)
- [Потоковая передача и разбиение на чанки](/concepts/streaming)
- [Маршрутизация нескольких агентов](/concepts/multi-agent)
- [Уплотнение](/concepts/compaction)
- [Сеансы](/concepts/session)
- [Сеансы (псевдоним)](/concepts/sessions)
- [Очистка сеансов](/concepts/session-pruning)
- [Инструменты сеансов](/concepts/session-tool)
- [Очередь](/concepts/queue)
- [Слэш-команды](/tools/slash-commands)
- [RPC-адаптеры](/reference/rpc)
- [Схемы TypeBox](/concepts/typebox)
- [Обработка часовых поясов](/concepts/timezone)
- [Присутствие](/concepts/presence)
- [Discovery + транспорты](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [Маршрутизация каналов](/channels/channel-routing)
- [Группы](/channels/groups)
- [Сообщения групп](/channels/group-messages)
- [Отказоустойчивость моделей](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## Провайдеры и ingress

- [Хаб чат-каналов](/channels)
- [Хаб провайдеров моделей](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Telegram (заметки grammY)](/channels/grammy)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost) (плагин)
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage (наследуемый)](/channels/imessage)
- [Разбор местоположения](/channels/location)
- [WebChat](/web/webchat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway (шлюз) и операции

- [Руководство по эксплуатации Gateway (шлюз)](/gateway)
- [Сетевая модель](/gateway/network-model)
- [Сопряжение Gateway (шлюз)](/gateway/pairing)
- [Блокировка Gateway (шлюз)](/gateway/gateway-lock)
- [Фоновый процесс](/gateway/background-process)
- [Состояние](/gateway/health)
- [Сигнал keepalive](/gateway/heartbeat)
- [Доктор](/gateway/doctor)
- [Логирование](/gateway/logging)
- [Sandboxing](/gateway/sandboxing)
- [Панель управления](/web/dashboard)
- [Интерфейс управления](/web/control-ui)
- [Удалённый доступ](/gateway/remote)
- [README удалённого Gateway (шлюз)](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [Безопасность](/gateway/security)
- [Устранение неполадок](/gateway/troubleshooting)

## Инструменты и автоматизация

- [Поверхность инструментов](/tools)
- [OpenProse](/prose)
- [Справочник CLI](/cli)
- [Инструмент Exec](/tools/exec)
- [Повышенный режим](/tools/elevated)
- [Задания Cron](/automation/cron-jobs)
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat)
- [Мышление и подробный вывод](/tools/thinking)
- [Модели](/concepts/models)
- [Суб-агенты](/tools/subagents)
- [CLI отправки агенту](/tools/agent-send)
- [Терминальный интерфейс](/web/tui)
- [Управление браузером](/tools/browser)
- [Браузер (устранение неполадок в Linux)](/tools/browser-linux-troubleshooting)
- [Опросы](/automation/poll)

## Узлы, медиа, голос

- [Обзор узлов](/nodes)
- [Камера](/nodes/camera)
- [Изображения](/nodes/images)
- [Аудио](/nodes/audio)
- [Команда местоположения](/nodes/location-command)
- [Голосовая активация](/nodes/voicewake)
- [Режим разговора](/nodes/talk)

## Платформы

- [Обзор платформ](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Веб-поверхности](/web)

## Сопутствующее приложение macOS (продвинуто)

- [Настройка разработки для macOS](/platforms/mac/dev-setup)
- [Строка меню macOS](/platforms/mac/menu-bar)
- [Голосовая активация macOS](/platforms/mac/voicewake)
- [Голосовой оверлей macOS](/platforms/mac/voice-overlay)
- [WebChat для macOS](/platforms/mac/webchat)
- [Canvas для macOS](/platforms/mac/canvas)
- [Дочерний процесс macOS](/platforms/mac/child-process)
- [Состояние macOS](/platforms/mac/health)
- [Иконка macOS](/platforms/mac/icon)
- [Логирование macOS](/platforms/mac/logging)
- [Разрешения macOS](/platforms/mac/permissions)
- [Удалённый доступ macOS](/platforms/mac/remote)
- [Подпись macOS](/platforms/mac/signing)
- [Релиз macOS](/platforms/mac/release)
- [Gateway (шлюз) macOS (launchd)](/platforms/mac/bundled-gateway)
- [XPC macOS](/platforms/mac/xpc)
- [Skills macOS](/platforms/mac/skills)
- [Peekaboo macOS](/platforms/mac/peekaboo)

## Рабочее пространство и шаблоны

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Конфиг Skills](/tools/skills-config)
- [AGENTS по умолчанию](/reference/AGENTS.default)
- [Шаблоны: AGENTS](/reference/templates/AGENTS)
- [Шаблоны: BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [Шаблоны: HEARTBEAT](/reference/templates/HEARTBEAT)
- [Шаблоны: IDENTITY](/reference/templates/IDENTITY)
- [Шаблоны: SOUL](/reference/templates/SOUL)
- [Шаблоны: TOOLS](/reference/templates/TOOLS)
- [Шаблоны: USER](/reference/templates/USER)

## Эксперименты (исследовательские)

- [Протокол конфигурации онбординга](/experiments/onboarding-config-protocol)
- [Заметки по усилению Cron](/experiments/plans/cron-add-hardening)
- [Заметки по усилению политики групп](/experiments/plans/group-policy-hardening)
- [Исследование: память](/experiments/research/memory)
- [Исследование конфигурации моделей](/experiments/proposals/model-config)

## Проект

- [Благодарности](/reference/credits)

## Тестирование и релизы

- [Тестирование](/reference/test)
- [Чек-лист релиза](/reference/RELEASING)
- [Модели устройств](/reference/device-models)
