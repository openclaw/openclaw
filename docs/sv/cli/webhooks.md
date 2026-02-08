---
summary: "CLI-referens för `openclaw webhooks` (webhook-hjälpare + Gmail Pub/Sub)"
read_when:
  - Du vill koppla Gmail Pub/Sub-händelser till OpenClaw
  - Du vill använda webhook-hjälparkommandon
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:49Z
---

# `openclaw webhooks`

Webhook-hjälpare och integrationer (Gmail Pub/Sub, webhook-hjälpare).

Relaterat:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Se [Gmail Pub/Sub-dokumentationen](/automation/gmail-pubsub) för detaljer.
