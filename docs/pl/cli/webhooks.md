---
summary: "Dokumentacja referencyjna CLI dla `openclaw webhooks` (narzędzia webhooków + Gmail Pub/Sub)"
read_when:
  - Chcesz podłączyć zdarzenia Gmail Pub/Sub do OpenClaw
  - Chcesz używać poleceń pomocniczych webhooków
title: "webhooki"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:58Z
---

# `openclaw webhooks`

Narzędzia pomocnicze webhooków i integracje (Gmail Pub/Sub, narzędzia webhooków).

Powiązane:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Zobacz [dokumentację Gmail Pub/Sub](/automation/gmail-pubsub), aby uzyskać szczegóły.
