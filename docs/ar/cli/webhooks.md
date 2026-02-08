---
summary: "مرجع CLI لأمر `openclaw webhooks` (مساعدات webhook + Gmail Pub/Sub)"
read_when:
  - "عندما تريد توصيل أحداث Gmail Pub/Sub بـ OpenClaw"
  - "عندما تريد أوامر مساعدات webhook"
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:58Z
---

# `openclaw webhooks`

مساعدات webhook والتكاملات (Gmail Pub/Sub، مساعدات webhook).

ذو صلة:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

راجع [توثيق Gmail Pub/Sub](/automation/gmail-pubsub) للتفاصيل.
