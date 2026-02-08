---
summary: "デバッグツール：ウォッチモード、生のモデルストリーム、推論リークのトレース"
read_when:
  - 推論リークを確認するために生のモデル出力を検査する必要がある場合
  - 反復作業中に Gateway（ゲートウェイ）をウォッチモードで実行したい場合
  - 再現性のあるデバッグワークフローが必要な場合
title: "デバッグ"
x-i18n:
  source_path: help/debugging.md
  source_hash: 504c824bff479000
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:08Z
---

# デバッグ

このページでは、ストリーミング出力のためのデバッグ補助について説明します。特に、プロバイダーが推論を通常のテキストに混在させる場合を対象としています。

## 実行時デバッグ上書き

チャット内で `/debug` を使用すると、**実行時のみ** の設定上書きを（ディスクではなくメモリ上で）行えます。
`/debug` はデフォルトで無効になっているため、`commands.debug: true` で有効化してください。
`openclaw.json` を編集せずに、あまり使われない設定を切り替えたい場合に便利です。

例:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` はすべての上書きをクリアし、オンディスクの設定に戻します。

## Gateway watch mode

高速な反復作業のために、ファイルウォッチャー配下でゲートウェイを実行します。

```bash
pnpm gateway:watch --force
```

これは次にマップされます。

```bash
tsx watch src/entry.ts gateway --force
```

`gateway:watch` の後ろに任意の gateway CLI フラグを追加すると、再起動のたびにそれらが引き渡されます。

## Dev プロファイル + dev ゲートウェイ（--dev）

dev プロファイルを使用すると、状態を分離し、デバッグ用に安全で使い捨て可能なセットアップを立ち上げられます。`--dev` フラグは **2 つ** あります。

- **グローバル `--dev`（プロファイル）:** 状態を `~/.openclaw-dev` 配下に分離し、ゲートウェイのポートをデフォルトで `19001` に設定します（派生ポートもそれに合わせてシフトします）。
- **`gateway --dev`:** Gateway（ゲートウェイ）に対し、存在しない場合にデフォルトの設定 + ワークスペースを自動作成し（BOOTSTRAP.md をスキップ）、起動するよう指示します。

推奨フロー（dev プロファイル + dev ブートストラップ）:

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

まだグローバルインストールがない場合は、`pnpm openclaw ...` 経由で CLI を実行してください。

この処理で行われること:

1. **プロファイルの分離**（グローバル `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（ブラウザー／キャンバスもそれに応じてシフト）

2. **Dev ブートストラップ**（`gateway --dev`）
   - 存在しない場合に最小構成の設定を書き込みます（`gateway.mode=local`、loopback にバインド）。
   - `agent.workspace` を dev ワークスペースに設定します。
   - `agent.skipBootstrap=true` を設定します（BOOTSTRAP.md なし）。
   - 存在しない場合にワークスペースファイルをシードします:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`。
   - デフォルトのアイデンティティ: **C3‑PO**（プロトコル・ドロイド）。
   - dev モードではチャンネルプロバイダーをスキップします（`OPENCLAW_SKIP_CHANNELS=1`）。

リセットフロー（クリーンスタート）:

```bash
pnpm gateway:dev:reset
```

注記: `--dev` は **グローバル** なプロファイルフラグであり、一部のランナーでは消費されてしまいます。
明示的に指定する必要がある場合は、環境変数形式を使用してください。

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` は、設定、認証情報、セッション、および dev ワークスペースを消去し（`rm` ではなく `trash` を使用）、その後にデフォルトの dev セットアップを再作成します。

ヒント: すでに非 dev のゲートウェイが稼働している場合（launchd/systemd）、先に停止してください。

```bash
openclaw gateway stop
```

## Raw stream logging（OpenClaw）

OpenClaw は、フィルタリングや整形が行われる前の **生のアシスタントストリーム** をログに出力できます。
推論がプレーンテキストの差分として届いているのか、あるいは独立した思考ブロックとして届いているのかを確認する最良の方法です。

CLI で有効化します。

```bash
pnpm gateway:watch --force --raw-stream
```

任意のパス上書き:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

同等の環境変数:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

デフォルトのファイル:

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging（pi-mono）

ブロックにパースされる前の **生の OpenAI 互換チャンク** を取得するために、
pi-mono は別個のロガーを提供します。

```bash
PI_RAW_STREAM=1
```

任意のパス:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

デフォルトのファイル:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注記: これは pi-mono の
> `openai-completions` プロバイダーを使用しているプロセスのみで出力されます。

## 安全性に関する注意

- Raw ストリームのログには、完全なプロンプト、ツール出力、ユーザーデータが含まれる場合があります。
- ログはローカルに保持し、デバッグ後は削除してください。
- ログを共有する場合は、事前にシークレットや個人情報（PII）を必ずマスキングしてください。
