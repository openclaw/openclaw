---
summary: "CLI リファレンス：`openclaw doctor`（ヘルスチェックとガイド付き修復）"
read_when:
  - 接続性や認証の問題があり、ガイド付きの修正を行いたい場合
  - 更新後に健全性チェックを行いたい場合
title: "ドクター"
---

# `openclaw doctor`

ゲートウェイとチャンネル向けのヘルスチェックとクイック修復です。

関連項目:

- トラブルシューティング： [Troubleshooting](/gateway/troubleshooting)
- セキュリティ監査： [Security](/gateway/security)

## 例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注記：

- 対話型プロンプト（キーチェーンや OAuth の修復など）は、stdin が TTY の場合かつ `--non-interactive` が **設定されていない** 場合にのみ実行されます。ヘッドレス実行（cron、Telegram、ターミナルなし）ではプロンプトはスキップされます。 ヘッドレスラン(cron、Telegram、端末なし)はプロンプトをスキップします。
- `--fix`（`--repair` のエイリアス）は、`~/.openclaw/openclaw.json.bak` にバックアップを書き込み、不明な設定キーを削除し、各削除内容を一覧表示します。

## macOS： `launchctl` 環境変数の上書き

以前に `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（または `...PASSWORD`）を実行した場合、その値が設定ファイルを上書きし、永続的な「unauthorized」エラーの原因となることがあります。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
