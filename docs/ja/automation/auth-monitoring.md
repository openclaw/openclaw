---
summary: "モデルプロバイダー向けの OAuth 有効期限を監視します"
read_when:
  - 認証の有効期限監視やアラートを設定する場合
  - Claude Code / Codex の OAuth リフレッシュ確認を自動化する場合
title: "認証監視"
---

# 認証監視

OpenClaw は、`openclaw models status` を通じて OAuth の有効期限のヘルス情報を公開します。これを自動化やアラートに使用してください。スクリプトは電話ワークフロー向けの任意の追加要素です。
オートメーションとアラートに使用します。スクリプトは電話ワークフローのオプションです。

## 推奨: CLI チェック（ポータブル）

```bash
openclaw models status --check
```

終了コード:

- `0`: OK
- `1`: 資格情報が期限切れ、または欠落しています
- `2`: まもなく期限切れ（24 時間以内）

これは cron/systemd で動作し、追加のスクリプトは不要です。

## 任意のスクリプト（運用 / 電話ワークフロー）

これらは `scripts/` の下にあり、**任意**です。 これらは `scripts/` 配下にあり、**任意** です。ゲートウェイ ホストへの SSH アクセスを前提とし、systemd + Termux 向けに調整されています。

- `scripts/claude-auth-status.sh` は、`openclaw models status --json` を信頼できる唯一の情報源として使用するようになりました（CLI が利用できない場合は直接ファイル読み取りにフォールバックします）。そのため、タイマー用に `PATH` 上の `openclaw` を維持してください。
- `scripts/auth-monitor.sh`: cron/systemd のタイマー対象。アラート（ntfy または電話）を送信します。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd ユーザータイマー。
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw の認証チェッカー（full/json/simple）。
- `scripts/mobile-reauth.sh`: SSH 経由のガイド付き再認証フロー。
- `scripts/termux-quick-auth.sh`: ワンタップのウィジェットステータス + 認証 URL を開きます。
- `scripts/termux-auth-widget.sh`: 完全なガイド付きウィジェットフロー。
- `scripts/termux-sync-widget.sh`: Claude Code の認証情報を OpenClaw に同期します。

電話の自動化や systemd タイマーが不要な場合は、これらのスクリプトをスキップしてください。
