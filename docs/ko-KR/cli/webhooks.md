---
summary: "`openclaw webhooks` CLI 참조 (웹훅 도우미 + Gmail Pub/Sub)"
read_when:
  - Gmail Pub/Sub 이벤트를 OpenClaw에 연결하고자 하는 경우
  - 웹훅 도우미 명령어가 필요한 경우
title: "webhooks"
---

# `openclaw webhooks`

웹훅 도우미 및 통합 (Gmail Pub/Sub, 웹훅 도우미).

관련 사항:

- 웹훅: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

자세한 내용은 [Gmail Pub/Sub 문서](/automation/gmail-pubsub)를 참조하세요.
