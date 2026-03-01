---
summary: "デバッグツール: ウォッチモード、未加工のモデルストリーム、推論リークのトレース"
read_when:
  - 推論リークの有無を確認するために未加工のモデル出力を検査したいとき
  - 反復作業中に Gateway をウォッチモードで実行したいとき
  - 再現性のあるデバッグワークフローが必要なとき
title: "デバッグ"
---

# デバッグ

このページでは、ストリーミング出力のデバッグヘルパーについて説明します。特に、プロバイダーが通常のテキストに推論を混在させる場合に役立ちます。

## ランタイムデバッグのオーバーライド

チャットで `/debug` を使用すると、**ランタイムのみ**の設定オーバーライド（メモリ上、ディスクには保存されません）を設定できます。
`/debug` はデフォルトで無効になっています。`commands.debug: true` で有効にしてください。
`openclaw.json` を編集せずに難解な設定を切り替えたい場合に便利です。

使用例:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` はすべてのオーバーライドをクリアし、ディスク上の設定に戻します。

## Gateway ウォッチモード

素早い反復作業のために、ファイルウォッチャー付きで Gateway を実行します:

```bash
pnpm gateway:watch
```

これは以下にマッピングされます:

```bash
node --watch-path src --watch-path tsconfig.json --watch-path package.json --watch-preserve-output scripts/run-node.mjs gateway --force
```

`gateway:watch` の後に任意の Gateway CLI フラグを追加すると、再起動のたびに引き渡されます。

## Dev プロファイル + Dev Gateway (--dev)

Dev プロファイルを使用すると、状態を隔離し、デバッグ用の安全で使い捨て可能なセットアップを立ち上げることができます。`--dev` フラグは**2つ**あります:

- **グローバル `--dev`（プロファイル）:** 状態を `~/.openclaw-dev` 以下に隔離し、Gateway ポートをデフォルトで `19001` に設定します（派生ポートもそれに合わせてシフトします）。
- **`gateway --dev`:** Gateway に対して、設定やワークスペースがない場合にデフォルトのものを自動作成するよう指示します（BOOTSTRAP.md はスキップされます）。

推奨フロー（Dev プロファイル + Dev ブートストラップ）:

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

グローバルインストールがない場合は、`pnpm openclaw ...` 経由で CLI を実行してください。

この設定が行うこと:

1. **プロファイルの隔離**（グローバル `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（ブラウザ/キャンバスも合わせてシフト）

2. **Dev ブートストラップ**（`gateway --dev`）
   - 設定がない場合に最小限の設定を書き込みます（`gateway.mode=local`、ループバックにバインド）。
   - `agent.workspace` を Dev ワークスペースに設定します。
   - `agent.skipBootstrap=true`（BOOTSTRAP.md なし）を設定します。
   - ワークスペースファイルがない場合にシードします:
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - デフォルトアイデンティティ: **C3-PO**（プロトコルドロイド）。
   - Dev モードではチャンネルプロバイダーをスキップします（`OPENCLAW_SKIP_CHANNELS=1`）。

リセットフロー（クリーンな再スタート）:

```bash
pnpm gateway:dev:reset
```

注意: `--dev` は**グローバル**プロファイルフラグであり、一部のランナーに認識されないことがあります。
明示的に指定する必要がある場合は、環境変数の形式を使用してください:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` は設定、クレデンシャル、セッション、Dev ワークスペースを（`rm` ではなく `trash` を使って）削除し、デフォルトの Dev セットアップを再作成します。

ヒント: 非 Dev の Gateway がすでに実行中（launchd/systemd）の場合は、先に停止してください:

```bash
openclaw gateway stop
```

## 未加工ストリームのログ（OpenClaw）

OpenClaw は、フィルタリング/フォーマット処理の前に**未加工のアシスタントストリーム**をログに記録できます。
これは、推論が通常のテキストデルタとして届いているか（または別の思考ブロックとして届いているか）を確認する最良の方法です。

CLI で有効にします:

```bash
pnpm gateway:watch --raw-stream
```

オプションのパスオーバーライド:

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

同等の環境変数:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

デフォルトファイル:

`~/.openclaw/logs/raw-stream.jsonl`

## 未加工チャンクのログ（pi-mono）

ブロックに解析される前の**未加工の OpenAI 互換チャンク**をキャプチャするために、pi-mono は別のロガーを公開しています:

```bash
PI_RAW_STREAM=1
```

オプションのパス:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

デフォルトファイル:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意: これは pi-mono の `openai-completions` プロバイダーを使用するプロセスからのみ出力されます。

## セキュリティに関する注意

- 未加工ストリームのログには、完全なプロンプト、ツール出力、ユーザーデータが含まれる場合があります。
- ログはローカルに保管し、デバッグ後は削除してください。
- ログを共有する場合は、先にシークレットと個人情報を削除してください。
