---
summary: "モデルプロバイダーの OAuth 有効期限を監視する"
read_when:
  - 認証有効期限の監視やアラートを設定するとき
  - Claude Code / Codex の OAuth リフレッシュチェックを自動化するとき
title: "認証監視"
---

# 認証監視

OpenClaw は `openclaw models status` を通じて OAuth 有効期限のヘルス状態を公開しています。自動化やアラートにはこのコマンドを使用してください。スクリプトは電話ワークフロー向けのオプション機能です。

## 推奨: CLI チェック（ポータブル）

```bash
openclaw models status --check
```

終了コード:

- `0`: 正常
- `1`: 認証情報が期限切れまたは存在しない
- `2`: 間もなく期限切れ（24時間以内）

これは cron/systemd で動作し、追加のスクリプトは不要です。

## オプションスクリプト（運用 / 電話ワークフロー）

これらは `scripts/` 以下にあり、**オプション**です。ゲートウェイホストへの SSH アクセスを前提とし、systemd + Termux 向けに調整されています。

- `scripts/claude-auth-status.sh`: 真実の情報源として `openclaw models status --json` を使用します（CLI が利用できない場合はファイルを直接読み込むフォールバックあり）。タイマー用に `openclaw` を `PATH` に追加してください。
- `scripts/auth-monitor.sh`: cron/systemd タイマーターゲット。アラートを送信します（ntfy または電話）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd ユーザータイマー。
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw 認証チェッカー（full/json/simple）。
- `scripts/mobile-reauth.sh`: SSH 経由のガイド付き再認証フロー。
- `scripts/termux-quick-auth.sh`: ワンタップウィジェットによるステータス確認と認証 URL を開く。
- `scripts/termux-auth-widget.sh`: 完全なガイド付きウィジェットフロー。
- `scripts/termux-sync-widget.sh`: Claude Code の認証情報を OpenClaw に同期する。

電話自動化や systemd タイマーが不要な場合は、これらのスクリプトをスキップしてください。
