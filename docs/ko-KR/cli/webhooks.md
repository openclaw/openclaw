---
summary: "`openclaw webhooks` CLI 레퍼런스 (웹훅 헬퍼 + Gmail Pub/Sub)"
read_when:
  - Gmail Pub/Sub 이벤트를 OpenClaw에 연결하고 싶을 때
  - 웹훅 헬퍼 명령어가 필요할 때
title: "webhooks"
x-i18n:
  source_path: "docs/cli/webhooks.md"
---

# `openclaw webhooks`

웹훅 헬퍼 및 통합 (Gmail Pub/Sub, 웹훅 헬퍼).

관련 문서:

- 웹훅: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

자세한 내용은 [Gmail Pub/Sub 문서](/automation/gmail-pubsub)를 참조하세요.
