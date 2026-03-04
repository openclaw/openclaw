---
summary: "`openclaw logs` のCLIリファレンス（RPC経由でGatewayログをtail）"
read_when:
  - SSH なしでリモートから Gateway ログを tail したい場合
  - ツール用の JSON ログ行が必要な場合
title: "logs"
---

# `openclaw logs`

RPC 経由で Gateway のファイルログを tail します（リモートモードで動作）。

関連：

- ログの概要：[ログ](/logging)

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
