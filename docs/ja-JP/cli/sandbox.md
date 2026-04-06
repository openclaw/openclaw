---
read_when: You are managing sandbox runtimes or debugging sandbox/tool-policy behavior.
status: active
summary: サンドボックスランタイムの管理と有効なサンドボックスポリシーの確認
title: サンドボックス CLI
x-i18n:
    generated_at: "2026-04-02T07:36:02Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fa2783037da2901316108d35e04bb319d5d57963c2764b9146786b3c6474b48a
    source_path: cli/sandbox.md
    workflow: 15
---

# サンドボックス CLI

分離されたエージェント実行のためのサンドボックスランタイムを管理します。

## 概要

OpenClawは、セキュリティのためにエージェントを分離されたサンドボックスランタイムで実行できます。`sandbox` コマンドは、更新や設定変更後にランタイムを確認・再作成するのに役立ちます。

現在、これは通常以下を意味します：

- Dockerサンドボックスコンテナ
- `agents.defaults.sandbox.backend = "ssh"` の場合のSSHサンドボックスランタイム
- `agents.defaults.sandbox.backend = "openshell"` の場合のOpenShellサンドボックスランタイム

`ssh` およびOpenShellの `remote` では、Dockerの場合よりも再作成が重要になります：

- 初回シード後はリモートワークスペースが正規のものとなる
- `openclaw sandbox recreate` は選択したスコープの正規リモートワークスペースを削除する
- 次回使用時に現在のローカルワークスペースから再度シードされる

## コマンド

### `openclaw sandbox explain`

**有効な**サンドボックスモード/スコープ/ワークスペースアクセス、サンドボックスツールポリシー、および昇格ゲート（修正用の設定キーパスを含む）を確認します。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

すべてのサンドボックスランタイムのステータスと設定を一覧表示します。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # ブラウザコンテナのみ表示
openclaw sandbox list --json     # JSON出力
```

**出力内容：**

- ランタイム名とステータス
- バックエンド（`docker`、`openshell` など）
- 設定ラベルと現在の設定との一致状況
- 経過時間（作成からの時間）
- アイドル時間（最後の使用からの時間）
- 関連するセッション/エージェント

### `openclaw sandbox recreate`

サンドボックスランタイムを削除し、更新された設定で再作成を強制します。

```bash
openclaw sandbox recreate --all                # すべてのコンテナを再作成
openclaw sandbox recreate --session main       # 特定のセッション
openclaw sandbox recreate --agent mybot        # 特定のエージェント
openclaw sandbox recreate --browser            # ブラウザコンテナのみ
openclaw sandbox recreate --all --force        # 確認をスキップ
```

**オプション：**

- `--all`：すべてのサンドボックスコンテナを再作成
- `--session <key>`：特定のセッションのコンテナを再作成
- `--agent <id>`：特定のエージェントのコンテナを再作成
- `--browser`：ブラウザコンテナのみ再作成
- `--force`：確認プロンプトをスキップ

**重要：** ランタイムは、エージェントが次に使用される際に自動的に再作成されます。

## ユースケース

### Dockerイメージを更新した後

```bash
# 新しいイメージをプル
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 新しいイメージを使用するように設定を更新
# 設定を編集: agents.defaults.sandbox.docker.image（または agents.list[].sandbox.docker.image）

# コンテナを再作成
openclaw sandbox recreate --all
```

### サンドボックス設定を変更した後

```bash
# 設定を編集: agents.defaults.sandbox.*（または agents.list[].sandbox.*）

# 新しい設定を適用するために再作成
openclaw sandbox recreate --all
```

### SSHターゲットまたはSSH認証情報を変更した後

```bash
# 設定を編集:
# - agents.defaults.sandbox.backend
# - agents.defaults.sandbox.ssh.target
# - agents.defaults.sandbox.ssh.workspaceRoot
# - agents.defaults.sandbox.ssh.identityFile / certificateFile / knownHostsFile
# - agents.defaults.sandbox.ssh.identityData / certificateData / knownHostsData

openclaw sandbox recreate --all
```

コアの `ssh` バックエンドでは、再作成によりSSHターゲット上のスコープごとのリモートワークスペースルートが削除されます。次回の実行時にローカルワークスペースから再度シードされます。

### OpenShellのソース、ポリシー、またはモードを変更した後

```bash
# 設定を編集:
# - agents.defaults.sandbox.backend
# - plugins.entries.openshell.config.from
# - plugins.entries.openshell.config.mode
# - plugins.entries.openshell.config.policy

openclaw sandbox recreate --all
```

OpenShellの `remote` モードでは、再作成によりそのスコープの正規リモートワークスペースが削除されます。次回の実行時にローカルワークスペースから再度シードされます。

### setupCommandを変更した後

```bash
openclaw sandbox recreate --all
# または特定のエージェントのみ:
openclaw sandbox recreate --agent family
```

### 特定のエージェントのみ

```bash
# 1つのエージェントのコンテナのみ更新
openclaw sandbox recreate --agent alfred
```

## なぜこれが必要なのか？

**問題：** サンドボックス設定を更新した場合：

- 既存のランタイムは古い設定のまま動作し続ける
- ランタイムは24時間の非アクティブ後にのみ削除される
- 定期的に使用されるエージェントは古いランタイムを無期限に保持し続ける

**解決策：** `openclaw sandbox recreate` を使用して古いランタイムの強制削除を行います。次に必要になったときに、現在の設定で自動的に再作成されます。

ヒント：手動でのバックエンド固有のクリーンアップよりも `openclaw sandbox recreate` を使用することを推奨します。
Gateway ゲートウェイのランタイムレジストリを使用し、スコープ/セッションキーの変更時の不整合を回避します。

## 設定

サンドボックス設定は `~/.openclaw/openclaw.json` の `agents.defaults.sandbox` に配置されます（エージェントごとのオーバーライドは `agents.list[].sandbox` に記述します）：

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "backend": "docker", // docker, ssh, openshell
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... その他のDockerオプション
        },
        "prune": {
          "idleHours": 24, // 24時間のアイドル後に自動削除
          "maxAgeDays": 7, // 7日後に自動削除
        },
      },
    },
  },
}
```

## 関連項目

- [サンドボックスのドキュメント](/gateway/sandboxing)
- [エージェント設定](/concepts/agent-workspace)
- [Doctor コマンド](/gateway/doctor) - サンドボックスのセットアップを確認
