---
summary: "Referência da CLI para `openclaw webhooks` (helpers de webhook + Gmail Pub/Sub)"
read_when:
  - Você quer conectar eventos do Gmail Pub/Sub ao OpenClaw
  - Você quer comandos auxiliares de webhook
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:28Z
---

# `openclaw webhooks`

Helpers e integrações de webhook (Gmail Pub/Sub, helpers de webhook).

Relacionado:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Veja a [documentação do Gmail Pub/Sub](/automation/gmail-pubsub) para detalhes.
