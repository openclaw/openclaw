---
summary: "`openclaw logs` のCLIリファレンス（RPC経由でGatewayログを追跡）"
read_when:
  - SSH不要でリモートからGatewayログを追跡する必要がある場合
  - ツーリング用のJSONログ行が必要な場合
title: "logs"
---

# `openclaw logs`

RPC経由でGatewayファイルログを追跡します（リモートモードで動作）。

関連：

- ロギング概要：[Logging](/logging)

## 使用例

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

`--local-time` を使用すると、タイムスタンプをローカルタイムゾーンで表示します。
