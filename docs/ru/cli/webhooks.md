---
summary: "Справочник CLI для `openclaw webhooks` (вспомогательные команды вебхуков + Gmail Pub/Sub)"
read_when:
  - Вам нужно подключить события Gmail Pub/Sub к OpenClaw
  - Вам нужны вспомогательные команды вебхуков
title: "вебхуки"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:22Z
---

# `openclaw webhooks`

Вспомогательные инструменты и интеграции для вебхуков (Gmail Pub/Sub, вспомогательные команды вебхуков).

Связанное:

- Вебхуки: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Подробности см. в [документации Gmail Pub/Sub](/automation/gmail-pubsub).
