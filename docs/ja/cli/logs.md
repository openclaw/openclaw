---
summary: "CLI 参照：`openclaw logs`（RPC 経由で Gateway（ゲートウェイ）のログを tail）"
read_when:
  - SSH なしで Gateway（ゲートウェイ）のログをリモートから tail する必要がある場合
  - ツール連携のために JSON 形式のログ行が必要な場合
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:08Z
---

# `openclaw logs`

RPC 経由で Gateway（ゲートウェイ）のファイルログを tail します（リモートモードで動作します）。

関連:

- ロギング概要: [Logging](/logging)

## 例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
