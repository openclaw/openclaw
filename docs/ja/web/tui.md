---
summary: "Terminal UI（TUI）：任意のマシンから Gateway（ゲートウェイ）に接続"
read_when:
  - TUI の初心者向けウォークスルーが必要な場合
  - TUI の機能、コマンド、ショートカットの完全な一覧が必要な場合
title: "TUI"
---

# TUI（Terminal UI）

## クイックスタート

1. Gateway（ゲートウェイ）を起動します。

```bash
openclaw gateway
```

2. TUI を開きます。

```bash
openclaw tui
```

3. メッセージを入力して Enter を押します。

リモート Gateway（ゲートウェイ）:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Gateway（ゲートウェイ）がパスワード認証を使用している場合は `--password` を使用してください。

## あなたが見るもの

- ヘッダー：接続 URL、現在のエージェント、現在のセッション。
- チャットログ：ユーザーメッセージ、アシスタントの返信、システム通知、ツールカード。
- ステータス行：接続／実行状態（接続中、実行中、ストリーミング中、アイドル、エラー）。
- フッター：接続状態 + エージェント + セッション + モデル + think／verbose／reasoning + トークン数 + deliver。
- 入力欄：オートコンプリート付きテキストエディター。

## メンタルモデル：エージェント + セッション

- エージェントは固有のナメクジです（例：`main`、`research`）。 ゲートウェイはリストを公開します。
- セッションは現在のエージェントに属します。
- セッションキーは `agent:<agentId>:<sessionKey>` として保存されます。
  - `/session main` と入力すると、TUI は `agent:<currentAgent>:main` に展開します。
  - `/session agent:other:main` と入力すると、そのエージェントのセッションに明示的に切り替わります。
- セッションスコープ：
  - `per-sender`（デフォルト）：各エージェントは複数のセッションを持ちます。
  - `global`：TUI は常に `global` セッションを使用します（ピッカーが空の場合があります）。
- 現在のエージェント + セッションは常にフッターに表示されます。

## 送信 + 配信

- メッセージは Gateway（ゲートウェイ）に送信されます。プロバイダーへの配信はデフォルトでオフです。
- 配送先:
  - `/deliver on`
  - または Settings パネル
  - または `openclaw tui --deliver` を付けて起動

## ピッカー + オーバーレイ

- モデルピッカー：利用可能なモデルを一覧表示し、セッションの上書きを設定します。
- エージェントピッカー：別のエージェントを選択します。
- セッションピッカー：現在のエージェントのセッションのみを表示します。
- 設定：deliver、ツール出力の展開、thinking 表示を切り替えます。

## キーボードショートカット

- Enter：メッセージ送信
- Esc：実行中のランを中断
- Ctrl+C：入力をクリア（2 回押すと終了）
- Ctrl+D：終了
- Ctrl+L：モデルピッカー
- Ctrl+G：エージェントピッカー
- Ctrl+P：セッションピッカー
- Ctrl+O：ツール出力展開の切り替え
- Ctrl+T：thinking 表示の切り替え（履歴を再読み込み）

## スラッシュコマンド

コア：

- `/help`
- `/status`
- `/agent <id>`（または `/agents`）
- `/session <key>`（または `/sessions`）
- `/model <provider/model>`（または `/models`）

セッション制御：

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>`（エイリアス：`/elev`）
- `/activation <mention|always>`
- `/deliver <on|off>`

セッションライフサイクル：

- `/new` または `/reset`（セッションをリセット）
- `/abort`（実行中のランを中断）
- `/settings`
- `/exit`

その他の Gateway（ゲートウェイ）のスラッシュコマンド（例：`/context`）は Gateway（ゲートウェイ）に転送され、システム出力として表示されます。詳細は [Slash commands](/tools/slash-commands) を参照してください。 [Slash commands](/tools/slash-commands)を参照してください。

## ローカルシェルコマンド

- 行頭に `!` を付けると、TUI ホスト上でローカルシェルコマンドを実行します。
- TUI はセッションごとに 1 回、ローカル実行を許可するか確認します。拒否すると、そのセッションでは `!` が無効のままになります。
- コマンドは TUI の作業ディレクトリで、新しい非対話型シェルとして実行されます（永続的な `cd`／env はありません）。
- 単独の `!` は通常のメッセージとして送信されます。行頭の空白はローカル実行をトリガーしません。

## ツール出力

- ツール呼び出しは、引数 + 結果を含むカードとして表示されます。
- Ctrl+O で折りたたみ／展開表示を切り替えます。
- ツール実行中は、部分的な更新が同じカードにストリーミングされます。

## 履歴 + ストリーミング

- 接続時に、最新の履歴（デフォルト 200 メッセージ）を読み込みます。
- ストリーミング応答は確定するまでその場で更新されます。
- TUI は、よりリッチなツールカードのためにエージェントのツールイベントもリッスンします。

## 接続の詳細

- TUI は `mode: "tui"` として Gateway（ゲートウェイ）に登録されます。
- 再接続時にはシステムメッセージが表示され、イベントの欠落はログに表示されます。

## オプション

- `--url <url>`：Gateway（ゲートウェイ）の WebSocket URL（デフォルトは設定または `ws://127.0.0.1:<port>`）
- `--token <token>`：Gateway（ゲートウェイ）トークン（必要な場合）
- `--password <password>`：Gateway（ゲートウェイ）パスワード（必要な場合）
- `--session <key>`：セッションキー（デフォルト：`main`、スコープがグローバルの場合は `global`）
- `--deliver`：アシスタントの返信をプロバイダーへ配信（デフォルトはオフ）
- `--thinking <level>`：送信時の thinking レベルを上書き
- `--timeout-ms <ms>`：エージェントのタイムアウト（ミリ秒、デフォルトは `agents.defaults.timeoutSeconds`）

注記：`--url` を設定した場合、TUI は設定や環境変数の認証情報にフォールバックしません。
`--token` または `--password` を明示的に指定してください。明示的な認証情報が欠けている場合はエラーとなります。
`--token` または `--password` を明示的に渡します。 明示的な資格情報が見つかりませんでした。

## トラブルシューティング

メッセージ送信後に出力がない場合：

- TUI で `/status` を実行し、Gateway（ゲートウェイ）が接続済みでアイドル／ビジーであることを確認します。
- Gateway（ゲートウェイ）のログを確認します：`openclaw logs --follow`。
- エージェントが実行可能であることを確認します：`openclaw status` および `openclaw models status`。
- チャットチャンネルにメッセージが届くはずの場合は、配信を有効にします（`/deliver on` または `--deliver`）。
- `--history-limit <n>`：読み込む履歴エントリ数（デフォルト 200）

## 接続トラブルシューティング

- `disconnected`：Gateway（ゲートウェイ）が稼働しており、`--url/--token/--password` が正しいことを確認してください。
- ピッカーにエージェントが表示されない場合：`openclaw agents list` とルーティング設定を確認してください。
- セッションピッカーが空の場合：グローバルスコープにいるか、まだセッションが存在しない可能性があります。
