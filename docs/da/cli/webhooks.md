---
summary: "CLI-reference for `openclaw webhooks` (webhook-hjælpere + Gmail Pub/Sub)"
read_when:
  - Du vil forbinde Gmail Pub/Sub-hændelser til OpenClaw
  - Du vil bruge webhook-hjælpekommandoer
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:02Z
---

# `openclaw webhooks`

Webhook-hjælpere og integrationer (Gmail Pub/Sub, webhook-hjælpere).

Relateret:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Se [Gmail Pub/Sub-dokumentationen](/automation/gmail-pubsub) for detaljer.
