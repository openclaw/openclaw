---
read_when:
  - 你想将 Gmail Pub/Sub 事件接入 OpenClaw
  - 你需要 Webhook 辅助命令
summary: "`openclaw webhooks`（Webhook 辅助工具 + Gmail Pub/Sub）的 CLI 参考"
title: webhooks
x-i18n:
  generated_at: "2026-02-01T20:21:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 785ec62afe6631b340ce4a4541ceb34cd6b97704cf7a9889762cb4c1f29a5ca0
  source_path: cli/webhooks.md
  workflow: 14
---

# `openclaw webhooks`

Webhook 辅助工具和集成（Gmail Pub/Sub、Webhook 辅助工具）。

相关内容：

- Webhook：[Webhook](/automation/webhook)
- Gmail Pub/Sub：[Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

详情请参阅 [Gmail Pub/Sub 文档](/automation/gmail-pubsub)。
