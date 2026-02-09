---
summary: "Мессенджинговые платформы, к которым может подключаться OpenClaw"
read_when:
  - Вы хотите выбрать чат-канал для OpenClaw
  - Вам нужен краткий обзор поддерживаемых мессенджинговых платформ
title: "Чат-каналы"
---

# Чат-каналы

OpenClaw может общаться с вами в любом чат-приложении, которым вы уже пользуетесь. Каждый канал подключается через Gateway (шлюз).
Текст поддерживается везде; поддержка медиа и реакций зависит от канала.

## Поддерживаемые каналы

- [WhatsApp](/channels/whatsapp) — Самый популярный; использует Baileys и требует QR‑сопряжения.
- [Telegram](/channels/telegram) — Bot API через grammY; поддерживает группы.
- [Discord](/channels/discord) — Discord Bot API + Gateway (шлюз); поддерживает серверы, каналы и личные сообщения.
- [Slack](/channels/slack) — Bolt SDK; приложения для рабочих пространств.
- [Feishu](/channels/feishu) — бот Feishu/Lark через WebSocket (плагин, устанавливается отдельно).
- [Google Chat](/channels/googlechat) — приложение Google Chat API через HTTP‑webhook.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; каналы, группы, личные сообщения (плагин, устанавливается отдельно).
- [Signal](/channels/signal) — signal-cli; ориентирован на приватность.
- [BlueBubbles](/channels/bluebubbles) — **Рекомендуется для iMessage**; использует REST API сервера BlueBubbles для macOS с полной поддержкой функций (редактирование, отмена отправки, эффекты, реакции, управление группами — редактирование в настоящее время не работает на macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Устаревшая интеграция macOS через imsg CLI (deprecated, для новых установок используйте BlueBubbles).
- [Microsoft Teams](/channels/msteams) — Bot Framework; поддержка корпоративных сценариев (плагин, устанавливается отдельно).
- [LINE](/channels/line) — бот LINE Messaging API (плагин, устанавливается отдельно).
- [Nextcloud Talk](/channels/nextcloud-talk) — Самостоятельно размещаемый чат через Nextcloud Talk (плагин, устанавливается отдельно).
- [Matrix](/channels/matrix) — протокол Matrix (плагин, устанавливается отдельно).
- [Nostr](/channels/nostr) — Децентрализованные личные сообщения через NIP‑04 (плагин, устанавливается отдельно).
- [Tlon](/channels/tlon) — Мессенджер на базе Urbit (плагин, устанавливается отдельно).
- [Twitch](/channels/twitch) — чат Twitch через IRC‑подключение (плагин, устанавливается отдельно).
- [Zalo](/channels/zalo) — Zalo Bot API; популярный мессенджер во Вьетнаме (плагин, устанавливается отдельно).
- [Zalo Personal](/channels/zalouser) — личный аккаунт Zalo через вход по QR (плагин, устанавливается отдельно).
- [WebChat](/web/webchat) — интерфейс WebChat Gateway (шлюза) поверх WebSocket.

## Примечания

- Каналы могут работать одновременно; настройте несколько, и OpenClaw будет маршрутизировать сообщения по чатам.
- Самая быстрая настройка обычно у **Telegram** (простой токен бота). WhatsApp требует QR‑сопряжения и
  хранит больше состояния на диске.
- Поведение в группах различается по каналам; см. [Группы](/channels/groups).
- Для безопасности применяются сопряжение личных сообщений и списки разрешённых; см. [Безопасность](/gateway/security).
- Внутренние детали Telegram: [заметки grammY](/channels/grammy).
- Устранение неполадок: [Устранение неполадок каналов](/channels/troubleshooting).
- Провайдеры моделей документируются отдельно; см. [Провайдеры моделей](/providers/models).
