---
summary: "Обзор сопряжения: кто может писать вам в личные сообщения + какие узлы могут подключаться"
read_when:
  - Настройка контроля доступа к личным сообщениям
  - Сопряжение нового узла iOS/Android
  - Проверка уровня безопасности OpenClaw
title: "Сопряжение"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:11Z
---

# Сопряжение

«Сопряжение» — это явный шаг **подтверждения владельцем** в OpenClaw.
Он используется в двух местах:

1. **Сопряжение личных сообщений (DM)** (кто имеет право общаться с ботом)
2. **Сопряжение узлов** (какие устройства/узлы могут подключаться к сети Gateway (шлюз))

Контекст безопасности: [Security](/gateway/security)

## 1) Сопряжение личных сообщений (входящий доступ к чату)

Когда для канала настроена политика личных сообщений `pairing`, неизвестные отправители получают короткий код, и их сообщение **не обрабатывается**, пока вы не одобрите доступ.

Политики личных сообщений по умолчанию описаны в разделе: [Security](/gateway/security)

Коды сопряжения:

- 8 символов, верхний регистр, без неоднозначных символов (`0O1I`).
- **Истекают через 1 час**. Бот отправляет сообщение с кодом сопряжения только при создании нового запроса (примерно раз в час на отправителя).
- Ожидающие запросы на сопряжение личных сообщений по умолчанию ограничены **3 на канал**; дополнительные запросы игнорируются, пока один из существующих не истечёт или не будет одобрен.

### Одобрить отправителя

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Поддерживаемые каналы: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Где хранится состояние

Хранится в `~/.openclaw/credentials/`:

- Ожидающие запросы: `<channel>-pairing.json`
- Список разрешённых (allowlist) одобренных отправителей: `<channel>-allowFrom.json`

Считайте эти данные чувствительными (они контролируют доступ к вашему ассистенту).

## 2) Сопряжение устройств-узлов (iOS/Android/macOS/headless узлы)

Узлы подключаются к Gateway (шлюз) как **устройства** с `role: node`. Gateway (шлюз)
создаёт запрос на сопряжение устройства, который необходимо одобрить.

### Одобрить устройство-узел

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Хранение состояния сопряжения узлов

Хранится в `~/.openclaw/devices/`:

- `pending.json` (краткоживущее; ожидающие запросы истекают)
- `paired.json` (сопряжённые устройства + токены)

### Примечания

- Устаревший API `node.pair.*` (CLI: `openclaw nodes pending/approve`) — это
  отдельное хранилище сопряжения, управляемое Gateway (шлюз). Узлы WS по‑прежнему требуют сопряжения устройств.

## Связанная документация

- Модель безопасности + prompt injection: [Security](/gateway/security)
- Безопасное обновление (запуск doctor): [Updating](/install/updating)
- Конфигурации каналов:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
