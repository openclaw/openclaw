---
summary: "`openclaw sessions` の CLI リファレンス（保存済みセッションの一覧表示 + 使用状況）"
read_when:
  - 保存済みセッションの一覧表示と最近のアクティビティの確認
title: "sessions"
---

# `openclaw sessions`

保存済みの会話セッションを一覧表示します。

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

スコープの選択:

- デフォルト: 設定済みのデフォルトエージェントストア
- `--agent <id>`: 1つの設定済みエージェントストア
- `--all-agents`: すべての設定済みエージェントストアを集約
- `--store <path>`: 明示的なストアパス（`--agent` や `--all-agents` と併用不可）

JSON の例:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-5" }
  ]
}
```

## クリーンアップメンテナンス

メンテナンスを即座に実行します（次の書き込みサイクルを待たずに）:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:dm:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` は設定の `session.maintenance` 設定を使用します:

- スコープに関する注意: `openclaw sessions cleanup` はセッションストア/トランスクリプトのみをメンテナンスします。cron 実行ログ（`cron/runs/<jobId>.jsonl`）はプルーニングしません。それらは [Cron 設定](/automation/cron-jobs#configuration) の `cron.runLog.maxBytes` と `cron.runLog.keepLines` で管理され、[Cron メンテナンス](/automation/cron-jobs#maintenance) で説明されています。

- `--dry-run`: 書き込みを行わずに、プルーニング/キャップされるエントリ数をプレビューします。
  - テキストモードでは、ドライランはセッションごとのアクションテーブル（`Action`、`Key`、`Age`、`Model`、`Flags`）を表示し、保持されるものと削除されるものを確認できます。
- `--enforce`: `session.maintenance.mode` が `warn` の場合でもメンテナンスを適用します。
- `--active-key <key>`: 特定のアクティブキーをディスクバジェットのエビクションから保護します。
- `--agent <id>`: 1つの設定済みエージェントストアに対してクリーンアップを実行します。
- `--all-agents`: すべての設定済みエージェントストアに対してクリーンアップを実行します。
- `--store <path>`: 特定の `sessions.json` ファイルに対して実行します。
- `--json`: JSON サマリーを出力します。`--all-agents` と併用すると、ストアごとに1つのサマリーが出力されます。

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

関連:

- セッション設定: [設定リファレンス](/gateway/configuration-reference#session)
