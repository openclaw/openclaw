---
summary: "macOS 上で動作する Gateway ランタイム（外部の launchd サービス）"
read_when:
  - OpenClaw.app のパッケージング
  - macOS の gateway launchd サービスのデバッグ
  - macOS 向け gateway CLI のインストール
title: "macOS 上の Gateway"
---

# macOS 上の Gateway（外部 launchd）

OpenClaw.app がNode/Bun や Gateway のランタイムをバンドルしなくなりました。 OpenClaw.app には、Node/Bun や Gateway ランタイムはもはや同梱されていません。macOS アプリは **外部** の `openclaw` CLI インストールを前提としており、Gateway を子プロセスとして起動しません。代わりに、Gateway を実行し続けるためのユーザー単位の launchd サービスを管理します（すでにローカルで Gateway が起動している場合は、それに接続します）。

## CLI のインストール（ローカルモードに必須）

Mac に Node 22+ が必要です。その後、`openclaw` をグローバルにインストールします。

```bash
npm install -g openclaw@<version>
```

macOS アプリの **Install CLI** ボタンは、npm/pnpm を介して同じ手順を実行します（Gateway ランタイムには bun は推奨されません）。

## Launchd（LaunchAgent としての Gateway）

ラベル:

- `bot.molt.gateway`（または `bot.molt.<profile>`。レガシーの `com.openclaw.*` が残る場合があります）

Plist の場所（ユーザー単位）:

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  （または `~/Library/LaunchAgents/bot.molt.<profile>.plist`）

管理:

- macOS アプリは、ローカルモードにおける LaunchAgent のインストール／更新を管理します。
- CLI からもインストールできます: `openclaw gateway install`。

動作:

- 「OpenClaw Active」で LaunchAgent を有効／無効にします。
- アプリを終了しても gateway は停止しません（launchd が稼働を維持します）。
- 設定されたポートで Gateway がすでに起動している場合、アプリは新しく起動せず、それに接続します。

ログ:

- launchd の stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## バージョン互換性

macOS アプリは、gateway のバージョンを自身のバージョンと照合します。互換性がない場合は、アプリのバージョンに合わせてグローバル CLI を更新してください。
互換性がない場合は、グローバルCLIをアプリのバージョンに合わせて更新してください。

## スモークチェック

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
