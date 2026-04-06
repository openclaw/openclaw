---
read_when:
    - 保存されたセッションの一覧や最近のアクティビティを確認したいとき
summary: '`openclaw sessions` の CLI リファレンス（保存されたセッションの一覧と使い方）'
title: sessions
x-i18n:
    generated_at: "2026-04-02T07:35:55Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 280bcdb0752ca067f33e085af6679cac40053edfc6a02e5b5864f53c90f2c10b
    source_path: cli/sessions.md
    workflow: 15
---

# `openclaw sessions`

保存された会話セッションを一覧表示します。

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

スコープの選択:

- デフォルト: 設定済みのデフォルトエージェントストア
- `--agent <id>`: 設定済みのエージェントストアを1つ指定
- `--all-agents`: 設定済みの全エージェントストアを集約
- `--store <path>`: ストアパスを明示的に指定（`--agent` や `--all-agents` とは併用不可）

`openclaw sessions --all-agents` は設定済みのエージェントストアを読み取ります。Gateway ゲートウェイと ACP のセッションディスカバリーはより広範で、デフォルトの `agents/` ルートまたはテンプレート化された `session.store` ルート配下にあるディスク上のストアも検出します。検出されたストアはエージェントルート内の通常の `sessions.json` ファイルに解決される必要があります。シンボリックリンクやルート外のパスはスキップされます。

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
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## クリーンアップメンテナンス

次の書き込みサイクルを待たずに、今すぐメンテナンスを実行します:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` は設定の `session.maintenance` 設定を使用します:

- スコープに関する注意: `openclaw sessions cleanup` はセッションストア/トランスクリプトのみをメンテナンスします。cron 実行ログ（`cron/runs/<jobId>.jsonl`）は削除しません。これらは [Cron 設定](/automation/cron-jobs#configuration)の `cron.runLog.maxBytes` と `cron.runLog.keepLines` で管理され、[Cron メンテナンス](/automation/cron-jobs#maintenance)で説明されています。

- `--dry-run`: 書き込みを行わず、削除・上限適用されるエントリ数をプレビューします。
  - テキストモードでは、dry-run はセッションごとのアクションテーブル（`Action`、`Key`、`Age`、`Model`、`Flags`）を出力し、保持されるものと削除されるものを確認できます。
- `--enforce`: `session.maintenance.mode` が `warn` の場合でもメンテナンスを適用します。
- `--active-key <key>`: 特定のアクティブキーをディスク容量制限による削除から保護します。
- `--agent <id>`: 設定済みのエージェントストア1つに対してクリーンアップを実行します。
- `--all-agents`: 設定済みの全エージェントストアに対してクリーンアップを実行します。
- `--store <path>`: 特定の `sessions.json` ファイルに対して実行します。
- `--json`: JSON サマリーを出力します。`--all-agents` を指定した場合、出力にはストアごとのサマリーが含まれます。

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
