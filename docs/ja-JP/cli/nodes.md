---
read_when:
    - ペアリングされたノード（カメラ、スクリーン、キャンバス）を管理している
    - リクエストを承認したい、またはノードコマンドを呼び出す必要がある
summary: '`openclaw nodes`（一覧/ステータス/承認/呼び出し、カメラ/キャンバス/スクリーン）のCLIリファレンス'
title: nodes
x-i18n:
    generated_at: "2026-04-02T07:34:24Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 91d16fba3c12c0cce5e585a7f5072a831de3e10928b2c34bdbf126b3b718e0c3
    source_path: cli/nodes.md
    workflow: 15
---

# `openclaw nodes`

ペアリングされたノード（デバイス）を管理し、ノード機能を呼び出します。

関連:

- ノード概要: [ノード](/nodes)
- カメラ: [カメラノード](/nodes/camera)
- 画像: [画像ノード](/nodes/images)

共通オプション:

- `--url`、`--token`、`--timeout`、`--json`

## よく使うコマンド

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list`は保留中/ペアリング済みのテーブルを表示します。ペアリング済みの行には最新の接続経過時間（Last Connect）が含まれます。
`--connected`を使用すると、現在接続中のノードのみを表示します。`--last-connected <duration>`を使用すると、指定した期間内に接続したノードでフィルタリングします（例: `24h`、`7d`）。

## 呼び出し

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
```

呼び出しフラグ:

- `--params <json>`: JSONオブジェクト文字列（デフォルト`{}`）。
- `--invoke-timeout <ms>`: ノード呼び出しタイムアウト（デフォルト`15000`）。
- `--idempotency-key <key>`: オプションの冪等キー。
- `system.run`と`system.run.prepare`はここではブロックされます。シェル実行には`host=node`を指定した`exec`ツールを使用してください。

ノード上でのシェル実行には、`openclaw nodes run`ではなく`host=node`を指定した`exec`ツールを使用してください。
`nodes` CLIは現在、機能に焦点を当てています: `nodes invoke`による直接RPC、およびペアリング、カメラ、スクリーン、位置情報、キャンバス、通知です。
