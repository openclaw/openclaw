---
summary: "「openclaw webhooks」の CLI リファレンス（Webhook ヘルパー + Gmail Pub/Sub）"
read_when:
  - Gmail Pub/Sub イベントを OpenClaw に接続したい場合
  - Webhook ヘルパーコマンドを使用したい場合
title: "ウェブフック"
---

# `openclaw webhooks`

Webhook ヘルパーおよび統合（Gmail Pub/Sub、Webhook ヘルパー）。

関連項目：

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

詳細は [Gmail Pub/Sub documentation](/automation/gmail-pubsub) を参照してください。
