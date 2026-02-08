---
summary: "`openclaw webhooks` için CLI referansı (webhook yardımcıları + Gmail Pub/Sub)"
read_when:
  - Gmail Pub/Sub etkinliklerini OpenClaw’a bağlamak istediğinizde
  - Webhook yardımcı komutlarını istediğinizde
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:03Z
---

# `openclaw webhooks`

Webhook yardımcıları ve entegrasyonlar (Gmail Pub/Sub, webhook yardımcıları).

İlgili:

- Webhook'lar: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Ayrıntılar için [Gmail Pub/Sub belgelerine](/automation/gmail-pubsub) bakın.
