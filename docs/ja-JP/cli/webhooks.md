---
summary: "`openclaw webhooks`（Webhookヘルパー + Gmail Pub/Sub）のCLIリファレンス"
read_when:
  - Gmail Pub/SubイベントをOpenClawに接続したい場合
  - Webhookヘルパーコマンドを使いたい場合
title: "webhooks"
---

# `openclaw webhooks`

Webhookヘルパーとインテグレーション（Gmail Pub/Sub、Webhookヘルパー）。

関連:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

詳細は[Gmail Pub/Subドキュメント](/automation/gmail-pubsub)を参照してください。
