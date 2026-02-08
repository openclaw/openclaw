---
summary: "Sanggunian ng CLI para sa `openclaw webhooks` (mga helper ng webhook + Gmail Pub/Sub)"
read_when:
  - Gusto mong ikonekta ang mga event ng Gmail Pub/Sub sa OpenClaw
  - Gusto mo ng mga command na helper para sa webhook
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:10Z
---

# `openclaw webhooks`

Mga helper at integrasyon ng webhook (Gmail Pub/Sub, mga helper ng webhook).

Kaugnay:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Tingnan ang [dokumentasyon ng Gmail Pub/Sub](/automation/gmail-pubsub) para sa mga detalye.
