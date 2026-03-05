---
summary: "`openclaw approvals`（Gatewayまたはノードホストのexec承認）のCLIリファレンス"
read_when:
  - CLIからexec承認を編集したい場合
  - Gatewayまたはノードホストの許可リストを管理する必要がある場合
title: "approvals"
x-i18n:
  source_path: docs/cli/approvals.md
  generated_at: "2026-03-05T10:01:00Z"
  model: claude-opus-4-6
  provider: pi
---

# `openclaw approvals`

**ローカルホスト**、**Gatewayホスト**、または**ノードホスト**のexec承認を管理します。
デフォルトでは、コマンドはディスク上のローカル承認ファイルを対象とします。Gatewayを対象にするには `--gateway` を、特定のノードを対象にするには `--node` を使用してください。

関連：

- Exec承認：[Exec approvals](/tools/exec-approvals)
- ノード：[Nodes](/nodes)

## よく使うコマンド

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## ファイルから承認を置換する

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

- `--node` は `openclaw nodes` と同じリゾルバーを使用します（id、名前、IP、またはidプレフィックス）。
- `--agent` のデフォルトは `"*"` で、すべてのエージェントに適用されます。
- ノードホストは `system.execApprovals.get/set` をアドバタイズしている必要があります（macOSアプリまたはヘッドレスノードホスト）。
- 承認ファイルはホストごとに `~/.openclaw/exec-approvals.json` に保存されます。
