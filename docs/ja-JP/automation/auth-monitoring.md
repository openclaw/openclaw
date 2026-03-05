---
summary: "モデルプロバイダーのOAuth有効期限を監視する"
read_when:
  - 認証の有効期限監視やアラートを設定する場合
  - Claude Code / Codex のOAuthリフレッシュチェックを自動化する場合
title: "認証監視"
x-i18n:
  source_path: docs/automation/auth-monitoring.md
  generated_at: "2026-03-05T10:01:00Z"
  model: claude-opus-4-6
  provider: pi
---

# 認証監視

OpenClawは `openclaw models status` を通じてOAuth有効期限のヘルスチェックを提供します。自動化やアラートにはこれを使用してください。スクリプトはモバイルワークフロー向けのオプション機能です。

## 推奨：CLIチェック（ポータブル）

```bash
openclaw models status --check
```

終了コード：

- `0`：正常
- `1`：認証情報が期限切れまたは見つからない
- `2`：まもなく期限切れ（24時間以内）

cron/systemdで動作し、追加スクリプトは不要です。

## オプション：スクリプト（運用 / モバイルワークフロー）

これらは `scripts/` 配下にあり、**オプション**です。ゲートウェイホストへのSSHアクセスを前提としており、systemd + Termux向けに調整されています。

- `scripts/claude-auth-status.sh` は `openclaw models status --json` を信頼できる情報源として使用するようになりました（CLIが利用できない場合はファイル直接読み取りにフォールバック）。タイマーでは `openclaw` を `PATH` に含めてください。
- `scripts/auth-monitor.sh`：cron/systemdタイマーのターゲット。アラートを送信します（ntfyまたはモバイル）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`：systemdユーザータイマー。
- `scripts/claude-auth-status.sh`：Claude Code + OpenClaw認証チェッカー（full/json/simple）。
- `scripts/mobile-reauth.sh`：SSH経由のガイド付き再認証フロー。
- `scripts/termux-quick-auth.sh`：ワンタップウィジェットによるステータス確認と認証URL表示。
- `scripts/termux-auth-widget.sh`：フルガイド付きウィジェットフロー。
- `scripts/termux-sync-widget.sh`：Claude Code認証情報をOpenClawに同期。

モバイル自動化やsystemdタイマーが不要な場合は、これらのスクリプトをスキップしてください。
