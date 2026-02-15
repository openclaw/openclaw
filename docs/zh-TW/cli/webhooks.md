---
summary: "`openclaw webhooks` 的 CLI 參考（webhook 輔助工具 + Gmail Pub/Sub）"
read_when:
  - 您想將 Gmail Pub/Sub 事件接入 OpenClaw
  - 您需要 webhook 輔助指令
title: "webhooks"
---

# `openclaw webhooks`

Webhook 輔助工具與整合（Gmail Pub/Sub、webhook 輔助工具）。

相關內容：

- Webhooks：[Webhook](/automation/webhook)
- Gmail Pub/Sub：[Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you @example.com
openclaw webhooks gmail run
```

請參閱 [Gmail Pub/Sub 文件](/automation/gmail-pubsub) 了解詳情。
