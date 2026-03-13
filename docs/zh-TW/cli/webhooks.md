---
summary: CLI reference for `openclaw webhooks` (webhook helpers + Gmail Pub/Sub)
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You want webhook helper commands
title: webhooks
---

# `openclaw webhooks`

Webhook 輔助工具與整合（Gmail Pub/Sub、Webhook 輔助工具）。

相關資源：

- Webhooks：[Webhook](/automation/webhook)
- Gmail Pub/Sub：[Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

詳情請參考 [Gmail Pub/Sub 文件](/automation/gmail-pubsub)。
