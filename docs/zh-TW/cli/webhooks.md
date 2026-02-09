---
summary: "「openclaw webhooks」的 CLI 參考（Webhook 輔助工具 + Gmail Pub/Sub）"
read_when:
  - 你想將 Gmail Pub/Sub 事件串接到 OpenClaw
  - 你想使用 Webhook 輔助指令
title: "webhooks"
---

# `openclaw webhooks`

Webhook 輔助工具與整合（Gmail Pub/Sub、Webhook 輔助工具）。

Related:

- Webhooks：[Webhook](/automation/webhook)
- Gmail Pub/Sub：[Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

如需詳細資訊，請參閱 [Gmail Pub/Sub 文件](/automation/gmail-pubsub)。
