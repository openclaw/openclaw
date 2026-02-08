---
summary: "Reference CLI pour `openclaw webhooks` (assistants de webhooks + Gmail Pub/Sub)"
read_when:
  - Vous souhaitez connecter des evenements Gmail Pub/Sub a OpenClaw
  - Vous souhaitez des commandes d'assistance pour les webhooks
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:05Z
---

# `openclaw webhooks`

Assistants de webhooks et integrations (Gmail Pub/Sub, assistants de webhooks).

Connexe :

- Webhooks : [Webhook](/automation/webhook)
- Gmail Pub/Sub : [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Voir la [documentation Gmail Pub/Sub](/automation/gmail-pubsub) pour plus de details.
