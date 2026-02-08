---
summary: "CLI-Referenz für `openclaw webhooks` (Webhook-Hilfsprogramme + Gmail Pub/Sub)"
read_when:
  - Sie möchten Gmail-Pub/Sub-Ereignisse in OpenClaw einbinden
  - Sie möchten Webhook-Hilfsbefehle verwenden
title: "Webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:44Z
---

# `openclaw webhooks`

Webhook-Hilfsprogramme und Integrationen (Gmail Pub/Sub, Webhook-Hilfsprogramme).

Zugehörig:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Siehe die [Gmail-Pub/Sub-Dokumentation](/automation/gmail-pubsub) für Details.
