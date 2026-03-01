---
summary: "`openclaw approvals` のCLIリファレンス（Gatewayまたはノードホストの実行承認）"
read_when:
  - CLIから実行承認を編集したい場合
  - Gatewayまたはノードホストの許可リストを管理する必要がある場合
title: "approvals"
---

# `openclaw approvals`

**ローカルホスト**、**Gatewayホスト**、または**ノードホスト**の実行承認を管理します。
デフォルトでは、コマンドはディスク上のローカル承認ファイルを対象とします。`--gateway` でGatewayを、`--node` で特定のノードを対象にできます。

関連：

- 実行承認：[Exec approvals](/tools/exec-approvals)
- ノード：[Nodes](/nodes)

## 一般的なコマンド

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## ファイルから承認を置換

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 許可リストヘルパー

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 注意事項

- `--node` は `openclaw nodes` と同じリゾルバー（id、名前、ip、またはidプレフィックス）を使用します。
- `--agent` のデフォルトは `"*"` で、全エージェントに適用されます。
- ノードホストは `system.execApprovals.get/set` を提供する必要があります（macOSアプリまたはヘッドレスノードホスト）。
- 承認ファイルはホストごとに `~/.openclaw/exec-approvals.json` に保存されます。
