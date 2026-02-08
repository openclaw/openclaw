---
summary: "Tham chiếu CLI cho `openclaw webhooks` (trợ giúp webhook + Gmail Pub/Sub)"
read_when:
  - Bạn muốn kết nối các sự kiện Gmail Pub/Sub vào OpenClaw
  - Bạn muốn các lệnh trợ giúp webhook
title: "webhooks"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:28Z
---

# `openclaw webhooks`

Các trợ giúp và tích hợp webhook (Gmail Pub/Sub, trợ giúp webhook).

Liên quan:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

Xem [tài liệu Gmail Pub/Sub](/automation/gmail-pubsub) để biết chi tiết.
