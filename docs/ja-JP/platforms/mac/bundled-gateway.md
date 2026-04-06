---
read_when:
    - OpenClaw.app のパッケージング時
    - macOS の Gateway ゲートウェイ launchd サービスのデバッグ時
    - macOS 用 Gateway ゲートウェイ CLI のインストール時
summary: macOS での Gateway ゲートウェイランタイム（外部 launchd サービス）
title: macOS での Gateway ゲートウェイ
x-i18n:
    generated_at: "2026-04-02T07:47:33Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 305744e4b0571d3a7991883d9fd890ba3e0af15d7c1d60803c45679c714ecf82
    source_path: platforms/mac/bundled-gateway.md
    workflow: 15
---

# macOS での Gateway ゲートウェイ（外部 launchd）

OpenClaw.app は Node/Bun や Gateway ゲートウェイランタイムをバンドルしなくなりました。macOS アプリは
**外部**の `openclaw` CLI インストールを前提とし、Gateway ゲートウェイを子プロセスとして
起動せず、Gateway ゲートウェイの実行を維持するためにユーザーごとの launchd サービスを
管理します（または、既にローカル Gateway ゲートウェイが実行中の場合はそれに接続します）。

## CLI のインストール（ローカルモードに必要）

Mac では Node 24 がデフォルトランタイムです。Node 22 LTS（現在 `22.14+`）も互換性のため引き続き動作します。次に `openclaw` をグローバルにインストールします:

```bash
npm install -g openclaw@<version>
```

macOS アプリの **Install CLI** ボタンは npm/pnpm 経由で同じフローを実行します（Gateway ゲートウェイランタイムには bun は推奨されません）。

## Launchd（LaunchAgent としての Gateway ゲートウェイ）

ラベル:

- `ai.openclaw.gateway`（または `ai.openclaw.<profile>`。レガシーの `com.openclaw.*` が残っている場合があります）

Plist の場所（ユーザーごと）:

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  （または `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`）

管理:

- macOS アプリがローカルモードで LaunchAgent のインストール/更新を管理します。
- CLI でもインストールできます: `openclaw gateway install`。

動作:

- 「OpenClaw Active」で LaunchAgent を有効/無効にします。
- アプリの終了は Gateway ゲートウェイを停止**しません**（launchd が維持します）。
- 設定されたポートで Gateway ゲートウェイが既に実行中の場合、アプリは新しいものを
  起動する代わりにそれに接続します。

ログ:

- launchd の stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## バージョン互換性

macOS アプリは Gateway ゲートウェイのバージョンを自身のバージョンと照合します。互換性が
ない場合は、グローバル CLI をアプリのバージョンに合わせて更新してください。

## 動作確認

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

次に:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
