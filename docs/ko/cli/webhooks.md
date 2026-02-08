---
summary: "`openclaw webhooks`에 대한 CLI 레퍼런스 (웹훅 헬퍼 + Gmail Pub/Sub)"
read_when:
  - Gmail Pub/Sub 이벤트를 OpenClaw에 연결하려는 경우
  - 웹훅 헬퍼 명령이 필요한 경우
title: "웹훅"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:31Z
---

# `openclaw webhooks`

웹훅 헬퍼 및 통합 (Gmail Pub/Sub, 웹훅 헬퍼).

관련:

- 웹훅: [웹훅](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

자세한 내용은 [Gmail Pub/Sub 문서](/automation/gmail-pubsub)를 참고하십시오.
