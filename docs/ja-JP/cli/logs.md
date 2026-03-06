---
summary: "`openclaw logs` のCLIリファレンス（RPCを介したGatewayログのtail）"
read_when:
  - リモートでGatewayログをtailしたい場合（SSHなし）
  - ツール用のJSONログ行が欲しい場合
title: "logs"
---

# `openclaw logs`

RPCを介してGatewayのファイルログをtailします（リモートモードで動作）。

関連：

- ロギングの概要：[ロギング](/logging)

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
