---
summary: "「openclaw webhooks」の CLI リファレンス（Webhook ヘルパー + Gmail Pub/Sub）"
read_when:
  - Gmail Pub/Sub イベントを OpenClaw に接続したい場合
  - Webhook ヘルパーコマンドを使用したい場合
title: "ウェブフック"
x-i18n:
  source_path: cli/webhooks.md
  source_hash: 785ec62afe6631b3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:20Z
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
