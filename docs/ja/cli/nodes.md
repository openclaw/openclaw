---
summary: "CLI リファレンス：`openclaw nodes`（一覧／ステータス／承認／呼び出し、カメラ／キャンバス／スクリーン）"
read_when:
  - ペアリングされたノード（カメラ、スクリーン、キャンバス）を管理している場合
  - リクエストを承認する、またはノードコマンドを呼び出す必要がある場合
title: "ノード"
---

# `openclaw nodes`

ペアリングされたノード（デバイス）を管理し、ノードの機能を呼び出します。

関連項目:

- ノード概要： [Nodes](/nodes)
- カメラ： [Camera nodes](/nodes/camera)
- 画像： [Image nodes](/nodes/images)

共通オプション：

- `--url`, `--token`, `--timeout`, `--json`

## 共通コマンド

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

`nodes list` は保留/ペアテーブルを表示します。 ペアリングされた行には、最新の接続年齢 (Last Connect) が含まれます。
現在接続されているノードのみを表示するには、 `--connected` を使用します。 <duration>には、 `--last-connected
`を使用して、持続時間内に接続されたノード(例えば `24h`, `7d`)にフィルターをかけます。

## Invoke / 実行

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke フラグ：

- `--params <json>`：JSON オブジェクト文字列（デフォルト：`{}`）。
- `--invoke-timeout <ms>`：ノード Invoke のタイムアウト（デフォルト：`15000`）。
- `--idempotency-key <key>`：任意の冪等性キー。

### Exec 形式のデフォルト

`nodes run` は、モデルの exec 振る舞い（デフォルト＋承認）を反映します：

- `tools.exec.*` を読み込みます（`agents.list[].tools.exec.*` の上書きを含む）。
- `system.run` を呼び出す前に、実行承認（`exec.approval.request`）を使用します。
- `tools.exec.node` が設定されている場合、`--node` は省略できます。
- `system.run` をアドバタイズするノードが必要です（macOS コンパニオンアプリ、またはヘッドレスのノードホスト）。

フラグ：

- `--cwd <path>`：作業ディレクトリ。
- `--env <key=val>`：環境変数の上書き（繰り返し指定可）。
- `--command-timeout <ms>`：コマンドのタイムアウト。
- `--invoke-timeout <ms>`：ノード Invoke のタイムアウト（デフォルト：`30000`）。
- `--needs-screen-recording`：画面録画の権限を必須にします。
- `--raw <command>`：シェル文字列を実行します（`/bin/sh -lc` または `cmd.exe /c`）。
- `--agent <id>`：エージェントスコープの承認／許可リスト（デフォルトは設定済みエージェント）。
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`：上書き設定。
