---
summary: "CLI reference for `openclaw webhooks` (webhook helpers + Gmail Pub/Sub)"
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You want webhook helper commands
title: "webhooks"
x-i18n:
  source_hash: 785ec62afe6631b340ce4a4541ceb34cd6b97704cf7a9889762cb4c1f29a5ca0
---

# `openclaw webhooks`

웹훅 도우미 및 통합(Gmail Pub/Sub, 웹훅 도우미)

관련 항목:

- 웹훅: [웹훅](/automation/webhook)
- Gmail 게시/구독: [Gmail 게시/구독](/automation/gmail-pubsub)

## 지메일

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

자세한 내용은 [Gmail Pub/Sub 문서](/automation/gmail-pubsub)를 참조하세요.
