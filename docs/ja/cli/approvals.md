---
summary: "CLI 参照：`openclaw approvals`（ゲートウェイまたはノード ホスト向けの実行承認）"
read_when:
  - CLI から実行承認を編集したい場合
  - ゲートウェイまたはノード ホスト上の許可リストを管理する必要がある場合
title: "approvals"
---

# `openclaw approvals`

**ローカル ホスト**、**ゲートウェイ ホスト**、または **ノード ホスト** の実行承認を管理します。  
既定では、コマンドはディスク上のローカル承認ファイルを対象にします。ゲートウェイを対象にするには `--gateway` を、特定のノードを対象にするには `--node` を使用します。
デフォルトでは、コマンドはディスク上のローカル承認ファイルをターゲットにします。 ゲートウェイをターゲットにするには `--gateway` を使用し、特定のノードをターゲットにするには `--node` を使用します。

関連項目：

- 実行承認： [Exec approvals](/tools/exec-approvals)
- ノード： [Nodes](/nodes)

## 共通コマンド

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## ファイルから承認を置き換える

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## 許可リストのヘルパー

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 注記

- `--node` は、`openclaw nodes`（id、name、ip、または id プレフィックス）と同じリゾルバーを使用します。
- `--agent` の既定値は `"*"` で、すべてのエージェントに適用されます。
- ノード ホストは `system.execApprovals.get/set`（macOS アプリまたはヘッドレス ノード ホスト）をアドバタイズする必要があります。
- 承認ファイルは、ホストごとに `~/.openclaw/exec-approvals.json` に保存されます。
