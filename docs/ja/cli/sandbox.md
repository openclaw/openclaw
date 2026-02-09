---
title: サンドボックス CLI
summary: "サンドボックスコンテナを管理し、有効なサンドボックスポリシーを検査します"
read_when: "サンドボックスコンテナを管理している場合、またはサンドボックス／ツールポリシーの挙動をデバッグしている場合。"
status: active
---

# サンドボックス CLI

隔離されたエージェント実行のための、Docker ベースのサンドボックスコンテナを管理します。

## 概要

OpenClaw は、セキュリティのためにエージェントを隔離された Docker コンテナ内で実行できます。`sandbox` コマンドは、特にアップデートや設定変更後に、これらのコンテナを管理するのに役立ちます。 `sandbox` コマンドは、これらのコンテナを管理するのに役立ちます。

## コマンド

### `openclaw sandbox explain`

**有効な** サンドボックスのモード／スコープ／ワークスペースアクセス、サンドボックスツールポリシー、および昇格されたゲート（修正用設定キーのパス付き）を検査します。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

すべてのサンドボックスコンテナを、そのステータスと設定とともに一覧表示します。

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**出力に含まれる内容:**

- コンテナ名とステータス（実行中／停止中）
- Docker イメージと、設定と一致しているかどうか
- 経過時間（作成からの時間）
- アイドル時間（最後に使用されてからの時間）
- 関連付けられたセッション／エージェント

### `openclaw sandbox recreate`

更新されたイメージ／設定で再作成を強制するために、サンドボックスコンテナを削除します。

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**オプション:**

- `--all`: すべてのサンドボックスコンテナを再作成
- `--session <key>`: 特定のセッションのコンテナを再作成
- `--agent <id>`: 特定のエージェントのコンテナを再作成
- `--browser`: ブラウザコンテナのみを再作成
- `--force`: 確認プロンプトをスキップ

**重要:** コンテナは、次にエージェントが使用される際に自動的に再作成されます。

## ユースケース

### Docker イメージを更新した後

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### サンドボックス設定を変更した後

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand を変更した後

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 特定のエージェントのみの場合

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## なぜこれが必要なのですか？

**問題:** サンドボックスの Docker イメージや設定を更新した場合:

- 既存のコンテナは古い設定のまま実行され続けます
- コンテナは、24 時間の非アクティブ状態の後にのみ削除されます
- 定期的に使用されるエージェントは、古いコンテナを無期限に実行し続けます

**解決策:** `openclaw sandbox recreate` を使用して、古いコンテナを強制的に削除します。次に必要になったとき、現在の設定で自動的に再作成されます。 次に必要に応じて、現在の設定で自動的に再作成されます。

ヒント: 手動の `docker rm` よりも `openclaw sandbox recreate` を優先してください。これは Gateway のコンテナ命名規則を使用し、スコープ／セッションキーが変更された際の不一致を回避します。
Gatewayのコンテナ名を使用し、スコープ/セッションキーが変更されたときに不一致を回避します。

## 設定

サンドボックス設定は、`agents.defaults.sandbox` 配下の `~/.openclaw/openclaw.json` にあります（エージェントごとの上書きは `agents.list[].sandbox` に記述します）:

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## See Also

- [サンドボックスドキュメント](/gateway/sandboxing)
- [エージェント設定](/concepts/agent-workspace)
- [Doctor コマンド](/gateway/doctor) - サンドボックスのセットアップを確認
