---
summary: "`openclaw nodes` の CLI リファレンス（list/status/approve/invoke、カメラ/キャンバス/スクリーン）"
read_when:
  - ペアリング済みノード（カメラ、スクリーン、キャンバス）の管理
  - リクエストの承認やノードコマンドの呼び出し
title: "nodes"
---

# `openclaw nodes`

ペアリング済みノード（デバイス）の管理とノード機能の呼び出しを行います。

関連:

- ノードの概要: [ノード](/nodes)
- カメラ: [カメラノード](/nodes/camera)
- 画像: [画像ノード](/nodes/images)

共通オプション:

- `--url`、`--token`、`--timeout`、`--json`

## 一般的なコマンド

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

`nodes list` はペンディング/ペアリング済みのテーブルを表示します。ペアリング済みの行には最新の接続経過時間（Last Connect）が含まれます。
`--connected` を使用すると現在接続中のノードのみを表示します。`--last-connected <duration>` を使用すると
指定した期間内（例: `24h`、`7d`）に接続したノードでフィルタリングできます。

## invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

invoke フラグ:

- `--params <json>`: JSON オブジェクト文字列（デフォルト `{}`）。
- `--invoke-timeout <ms>`: ノード invoke タイムアウト（デフォルト `15000`）。
- `--idempotency-key <key>`: オプションのべき等キー。

### exec スタイルのデフォルト

`nodes run` はモデルの exec 動作（デフォルト + 承認）を模倣します:

- `tools.exec.*`（および `agents.list[].tools.exec.*` のオーバーライド）を読み取ります。
- `system.run` を呼び出す前に exec 承認（`exec.approval.request`）を使用します。
- `tools.exec.node` が設定されている場合、`--node` は省略できます。
- `system.run` をアドバタイズするノード（macOS コンパニオンアプリまたはヘッドレスノードホスト）が必要です。

フラグ:

- `--cwd <path>`: 作業ディレクトリ。
- `--env <key=val>`: 環境変数のオーバーライド（繰り返し指定可能）。注意: ノードホストは `PATH` のオーバーライドを無視します（`tools.exec.pathPrepend` はノードホストには適用されません）。
- `--command-timeout <ms>`: コマンドタイムアウト。
- `--invoke-timeout <ms>`: ノード invoke タイムアウト（デフォルト `30000`）。
- `--needs-screen-recording`: スクリーンレコーディングの権限を要求する。
- `--raw <command>`: シェル文字列を実行する（`/bin/sh -lc` または `cmd.exe /c`）。
  Windows ノードホストの許可リストモードでは、`cmd.exe /c` シェルラッパーの実行には承認が必要です
  （許可リストのエントリだけではラッパー形式は自動許可されません）。
- `--agent <id>`: エージェントスコープの承認/許可リスト（デフォルトは設定済みエージェント）。
- `--ask <off|on-miss|always>`、`--security <deny|allowlist|full>`: オーバーライド。
