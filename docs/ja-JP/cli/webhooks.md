---
read_when:
    - Gmail Pub/SubイベントをOpenClawに接続したい場合
    - Webhookヘルパーコマンドが必要な場合
summary: '`openclaw webhooks`（Webhookヘルパー + Gmail Pub/Sub）のCLIリファレンス'
title: webhooks
x-i18n:
    generated_at: "2026-04-02T07:36:07Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 785ec62afe6631b340ce4a4541ceb34cd6b97704cf7a9889762cb4c1f29a5ca0
    source_path: cli/webhooks.md
    workflow: 15
---

# `openclaw webhooks`

Webhookヘルパーとインテグレーション（Gmail Pub/Sub、Webhookヘルパー）。

関連:

- Webhook: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

詳細は[Gmail Pub/Subドキュメント](/automation/gmail-pubsub)を参照してください。
