---
summary: "`openclaw doctor` のCLIリファレンス（ヘルスチェック + ガイド付き修復）"
read_when:
  - 接続性/認証の問題がありガイド付き修正が必要な場合
  - アップデート後にサニティチェックをしたい場合
title: "doctor"
---

# `openclaw doctor`

Gatewayとチャネルのヘルスチェック + クイックフィックスを行います。

関連：

- トラブルシューティング：[Troubleshooting](/gateway/troubleshooting)
- セキュリティ監査：[Security](/gateway/security)

## 使用例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注意事項：

- 対話型プロンプト（キーチェーン/OAuthの修正など）は、stdinがTTYであり `--non-interactive` が設定されて**いない**場合にのみ実行されます。ヘッドレス実行（cron、Telegram、ターミナルなし）ではプロンプトはスキップされます。
- `--fix`（`--repair` のエイリアス）は `~/.openclaw/openclaw.json.bak` にバックアップを書き込み、不明な設定キーを削除して、各削除をリスト表示します。
- 状態の整合性チェックにより、セッションディレクトリ内の孤立したトランスクリプトファイルを検出し、安全にスペースを回収するために `.deleted.<timestamp>` としてアーカイブできるようになりました。
- Doctorにはメモリ検索の準備状況チェックが含まれており、埋め込み資格情報が不足している場合に `openclaw configure --section model` を推奨できます。
- サンドボックスモードが有効だがDockerが利用できない場合、doctorは修復手順（`install Docker` または `openclaw config set agents.defaults.sandbox.mode off`）付きの高信号警告を報告します。

## macOS: `launchctl` 環境変数の上書き

以前 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（または `...PASSWORD`）を実行した場合、その値が設定ファイルを上書きし、永続的な「unauthorized」エラーの原因となる可能性があります。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
