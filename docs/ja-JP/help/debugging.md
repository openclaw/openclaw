---
read_when:
    - 推論リークについて生のモデル出力を検査する必要がある場合
    - 反復作業中に Gateway ゲートウェイをウォッチモードで実行したい場合
    - 再現可能なデバッグワークフローが必要な場合
summary: 'デバッグツール: ウォッチモード、生のモデルストリーム、推論リークのトレース'
title: デバッグ
x-i18n:
    generated_at: "2026-04-02T07:43:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f90d944ecc2e846ca0b26a162126ceefb3a3c6cf065c99b731359ec79d4289e3
    source_path: help/debugging.md
    workflow: 15
---

# デバッグ

このページでは、ストリーミング出力のデバッグヘルパーについて説明します。特にプロバイダーが推論を通常のテキストに混在させる場合に役立ちます。

## ランタイムデバッグオーバーライド

チャットで `/debug` を使用して、**ランタイム限定**の設定オーバーライド（メモリ上のみ、ディスクには書き込まれません）を設定できます。
`/debug` はデフォルトで無効です。`commands.debug: true` で有効化してください。
`openclaw.json` を編集せずに、あまり使わない設定を切り替えたい場合に便利です。

例:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` はすべてのオーバーライドをクリアし、ディスク上の設定に戻します。

## Gateway ゲートウェイのウォッチモード

素早い反復作業のために、ファイルウォッチャーの下で Gateway ゲートウェイを実行します:

```bash
pnpm gateway:watch
```

これは以下にマッピングされます:

```bash
node scripts/watch-node.mjs gateway --force
```

ウォッチャーは `src/` 配下のビルド関連ファイル、拡張機能のソースファイル、
拡張機能の `package.json` と `openclaw.plugin.json` メタデータ、`tsconfig.json`、
`package.json`、および `tsdown.config.ts` の変更時に再起動します。拡張機能のメタデータ変更は
`tsdown` の再ビルドを強制せずに Gateway ゲートウェイを再起動します。ソースと設定の変更では
先に `dist` を再ビルドします。

`gateway:watch` の後に Gateway ゲートウェイの CLI フラグを追加すると、再起動のたびにそれらが渡されます。

## dev プロファイル + dev Gateway ゲートウェイ (--dev)

dev プロファイルを使用して状態を分離し、デバッグ用の安全で使い捨てのセットアップを構築できます。**2つの** `--dev` フラグがあります:

- **グローバル `--dev`（プロファイル）:** 状態を `~/.openclaw-dev` に分離し、Gateway ゲートウェイのポートをデフォルトで `19001` にします（派生ポートもそれに合わせてシフトします）。
- **`gateway --dev`: Gateway ゲートウェイにデフォルト設定 + ワークスペースが存在しない場合に自動作成させます**（BOOTSTRAP.md をスキップします）。

推奨フロー（dev プロファイル + dev ブートストラップ）:

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

グローバルインストールがまだない場合は、`pnpm openclaw ...` で CLI を実行してください。

この操作で行われること:

1. **プロファイル分離**（グローバル `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（ブラウザ/キャンバスもそれに応じてシフト）

2. **dev ブートストラップ**（`gateway --dev`）
   - 存在しない場合に最小限の設定を書き込みます（`gateway.mode=local`、local loopback にバインド）。
   - `agent.workspace` を dev ワークスペースに設定します。
   - `agent.skipBootstrap=true` を設定します（BOOTSTRAP.md なし）。
   - 存在しない場合にワークスペースファイルをシードします:
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - デフォルトのアイデンティティ: **C3‑PO**（プロトコルドロイド）。
   - dev モードではチャネルプロバイダーをスキップします（`OPENCLAW_SKIP_CHANNELS=1`）。

リセットフロー（初期状態に戻す）:

```bash
pnpm gateway:dev:reset
```

注意: `--dev` は**グローバル**プロファイルフラグで、一部のランナーに消費されます。
明示的に指定する必要がある場合は、環境変数の形式を使用してください:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` は設定、認証情報、セッション、dev ワークスペースを消去し（`rm` ではなく `trash` を使用）、デフォルトの dev セットアップを再作成します。

ヒント: dev 以外の Gateway ゲートウェイがすでに実行中（launchd/systemd）の場合は、先に停止してください:

```bash
openclaw gateway stop
```

## 生のストリームログ（OpenClaw）

OpenClaw はフィルタリング/フォーマット前の**生のアシスタントストリーム**をログに記録できます。
推論がプレーンテキストのデルタとして到着しているか（または別々の thinking ブロックとして到着しているか）を確認する最良の方法です。

CLI で有効化:

```bash
pnpm gateway:watch --raw-stream
```

パスのオーバーライド（任意）:

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

## 生のチャンクログ（pi-mono）

ブロックにパースされる前の**生の OpenAI 互換チャンク**をキャプチャするために、
pi-mono は別のロガーを公開しています:

```bash
PI_RAW_STREAM=1
```

パスの指定（任意）:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

デフォルトファイル:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意: これは pi-mono の `openai-completions` プロバイダーを使用するプロセスからのみ出力されます。

## 安全に関する注意事項

- 生のストリームログにはプロンプト全文、ツール出力、ユーザーデータが含まれる場合があります。
- ログはローカルに保管し、デバッグ後に削除してください。
- ログを共有する場合は、シークレットと個人情報を先に除去してください。
