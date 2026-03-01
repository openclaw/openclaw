---
summary: "macOSにおけるGatewayランタイム（外部launchdサービス）"
read_when:
  - OpenClaw.appのパッケージング
  - macOS Gateway launchdサービスのデバッグ
  - macOS用Gateway CLIのインストール
title: "macOSでのGateway"
---

# macOSでのGateway（外部launchd）

OpenClaw.appはNode/BunやGatewayランタイムをバンドルしなくなりました。macOSアプリは**外部**の`openclaw` CLIインストールを前提としており、Gatewayを子プロセスとして起動しません。Gatewayの実行を維持するためにユーザーごとのlaunchdサービスを管理します（すでに実行中のローカルGatewayがある場合はそれに接続します）。

## CLIのインストール（ローカルモードに必要）

Macに Node 22+ が必要です。その後、`openclaw`をグローバルにインストールします：

```bash
npm install -g openclaw@<version>
```

macOSアプリの**Install CLI**ボタンは、npm/pnpm経由で同じフローを実行します（Gatewayランタイムにはbunは推奨されません）。

## Launchd（LaunchAgentとしてのGateway）

ラベル：

- `ai.openclaw.gateway`（または`ai.openclaw.<profile>`、レガシーの`com.openclaw.*`が残っている場合もあります）

Plistの場所（ユーザーごと）：

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  （または`~/Library/LaunchAgents/ai.openclaw.<profile>.plist`）

管理者：

- macOSアプリがローカルモードでLaunchAgentのインストール/更新を担当します。
- CLIからもインストール可能です：`openclaw gateway install`。

動作：

- 「OpenClaw Active」でLaunchAgentの有効化/無効化を切り替えます。
- アプリを終了してもGatewayは**停止しません**（launchdが維持します）。
- 設定されたポートですでにGatewayが実行中の場合、アプリは新しいものを起動せずにそれに接続します。

ログ：

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## バージョン互換性

macOSアプリはGatewayのバージョンを自身のバージョンと照合します。互換性がない場合は、グローバルCLIをアプリのバージョンに合わせて更新してください。

## スモークチェック

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

次に：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
