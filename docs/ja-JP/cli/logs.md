---
read_when:
    - SSHなしでリモートからGateway ゲートウェイのログを確認したい場合
    - ツール連携用にJSONログ行を取得したい場合
summary: '`openclaw logs`（RPC経由でGateway ゲートウェイのログを取得する）のCLIリファレンス'
title: logs
x-i18n:
    generated_at: "2026-04-02T07:33:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 81be02b6f8acad32ccf2d280827c7188a3c2f6bba0de5cbfa39fcc0bee3129cd
    source_path: cli/logs.md
    workflow: 15
---

# `openclaw logs`

RPC経由でGateway ゲートウェイのファイルログを取得します（リモートモードで動作します）。

関連:

- ロギングの概要: [ロギング](/logging)

## 使用例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

`--local-time` を使用すると、タイムスタンプがローカルタイムゾーンで表示されます。
