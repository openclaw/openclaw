---
summary: "`openclaw webhooks` の CLI リファレンス（Webhook ヘルパー + Gmail Pub/Sub）"
read_when:
  - Gmail Pub/Sub イベントを OpenClaw に接続したい場合
  - Webhook ヘルパーコマンドが必要な場合
title: "webhooks"
---

# `openclaw webhooks`

Webhook ヘルパーとインテグレーション（Gmail Pub/Sub、Webhook ヘルパー）です。

関連:

- Webhook: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

詳細については [Gmail Pub/Sub ドキュメント](/automation/gmail-pubsub) を参照してください。
