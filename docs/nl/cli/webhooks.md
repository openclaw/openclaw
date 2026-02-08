---
summary: "CLI-referentie voor `openclaw webhooks` (webhookhelpers + Gmail Pub/Sub)"
read_when:
  - Je wilt Gmail Pub/Sub-gebeurtenissen koppelen aan OpenClaw
  - Je wilt webhook-helperopdrachten
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:09Z
---

# `openclaw webhooks`

Webhookhelpers en integraties (Gmail Pub/Sub, webhookhelpers).

Gerelateerd:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Zie de [Gmail Pub/Sub-documentatie](/automation/gmail-pubsub) voor details.
