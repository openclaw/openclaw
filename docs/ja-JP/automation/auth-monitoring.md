---
read_when:
    - 認証の有効期限監視やアラートを設定する場合
    - Claude Code / Codex のOAuthリフレッシュチェックを自動化する場合
summary: モデルプロバイダーのOAuth有効期限を監視する
title: 認証モニタリング
x-i18n:
    generated_at: "2026-04-02T07:29:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: eef179af9545ed7ab881f3ccbef998869437fb50cdb4088de8da7223b614fa2b
    source_path: automation/auth-monitoring.md
    workflow: 15
---

# 認証モニタリング

OpenClawは`openclaw models status`を通じてOAuth有効期限のヘルスチェックを提供します。自動化やアラートにはこれを使用してください。スクリプトはスマートフォンワークフロー向けのオプションの補助ツールです。

## 推奨: CLIチェック（ポータブル）

```bash
openclaw models status --check
```

終了コード:

- `0`: OK
- `1`: 資格情報が期限切れまたは見つからない
- `2`: まもなく期限切れ（24時間以内）

これはcron/systemdで動作し、追加のスクリプトは不要です。

## オプションスクリプト（運用 / スマートフォンワークフロー）

これらは`scripts/`配下にあり、**オプション**です。Gateway ゲートウェイホストへのSSHアクセスを前提としており、systemd + Termux向けに調整されています。

- `scripts/claude-auth-status.sh`は信頼できる情報源として`openclaw models status --json`を使用するようになりました（CLIが利用できない場合はファイルの直接読み取りにフォールバックします）。タイマー用に`openclaw`を`PATH`に含めてください。
- `scripts/auth-monitor.sh`: cron/systemdタイマーのターゲット。アラートを送信します（ntfyまたはスマートフォン）。
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemdユーザータイマー。
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw認証チェッカー（full/json/simple）。
- `scripts/mobile-reauth.sh`: SSH経由のガイド付き再認証フロー。
- `scripts/termux-quick-auth.sh`: ワンタップウィジェットでのステータス確認 + 認証URLを開く。
- `scripts/termux-auth-widget.sh`: フルガイド付きウィジェットフロー。
- `scripts/termux-sync-widget.sh`: Claude Codeの資格情報をOpenClawに同期。

スマートフォンの自動化やsystemdタイマーが不要な場合は、これらのスクリプトをスキップしてください。
