---
read_when:
    - CLIから実行承認を編集したい
    - Gateway ゲートウェイまたはノードホストの許可リストを管理する必要がある
summary: '`openclaw approvals`（Gateway ゲートウェイまたはノードホストの実行承認）のCLIリファレンス'
title: approvals
x-i18n:
    generated_at: "2026-04-02T07:32:33Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: ecfd3d19e94883205c71d759163ab7b032bba52ec4ebf1bb75e2de54bfddec45
    source_path: cli/approvals.md
    workflow: 15
---

# `openclaw approvals`

**ローカルホスト**、**Gateway ゲートウェイホスト**、または**ノードホスト**の実行承認を管理します。
デフォルトでは、コマンドはディスク上のローカル承認ファイルを対象とします。`--gateway`を使用してGateway ゲートウェイを対象にするか、`--node`を使用して特定のノードを対象にします。

関連:

- 実行承認: [実行承認](/tools/exec-approvals)
- ノード: [ノード](/nodes)

## よく使うコマンド

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

`openclaw approvals get`は、ローカル、Gateway ゲートウェイ、ノードの各対象について有効な実行ポリシーを表示します:

- リクエストされた`tools.exec`ポリシー
- ホスト承認ファイルのポリシー
- 優先順位ルール適用後の有効な結果

優先順位は意図的なものです:

- ホスト承認ファイルが強制力のある信頼できるソースです
- リクエストされた`tools.exec`ポリシーは意図を狭めたり広げたりできますが、有効な結果は依然としてホストルールから導出されます
- `--node`はノードホストの承認ファイルとGateway ゲートウェイの`tools.exec`ポリシーを組み合わせます。ランタイム時には両方が適用されるためです
- Gateway ゲートウェイの設定が利用できない場合、CLIはノード承認のスナップショットにフォールバックし、最終的なランタイムポリシーが計算できなかったことを通知します

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

- `--node`は`openclaw nodes`と同じリゾルバー（id、name、ip、またはidプレフィックス）を使用します。
- `--agent`のデフォルトは`"*"`で、すべてのエージェントに適用されます。
- ノードホストは`system.execApprovals.get/set`をアドバタイズしている必要があります（macOSアプリまたはヘッドレスノードホスト）。
- 承認ファイルはホストごとに`~/.openclaw/exec-approvals.json`に保存されます。
