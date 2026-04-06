---
read_when:
    - 接続/認証の問題がありガイド付き修正を行いたい
    - アップデート後にインストール確認をしたい
summary: '`openclaw doctor`（ヘルスチェック＋ガイド付き修復）のCLIリファレンス'
title: doctor
x-i18n:
    generated_at: "2026-04-02T07:33:39Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 405962a14a8363c647121073aa7356e5bb02a8c246ef95562171d69559e06f88
    source_path: cli/doctor.md
    workflow: 15
---

# `openclaw doctor`

Gateway ゲートウェイとチャネルのヘルスチェック＋クイックフィックスです。

関連:

- トラブルシューティング: [トラブルシューティング](/gateway/troubleshooting)
- セキュリティ監査: [セキュリティ](/gateway/security)

## 例

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

注意事項:

- 対話型プロンプト（キーチェーン/OAuthの修正など）は、stdinがTTYであり`--non-interactive`が**設定されていない**場合にのみ実行されます。ヘッドレス実行（cron、Telegram、ターミナルなし）ではプロンプトはスキップされます。
- `--fix`（`--repair`のエイリアス）は`~/.openclaw/openclaw.json.bak`にバックアップを書き込み、不明な設定キーを削除して、各削除をリスト表示します。
- 状態整合性チェックにより、セッションディレクトリ内の孤立したトランスクリプトファイルを検出し、安全にスペースを回収するために`.deleted.<timestamp>`としてアーカイブできるようになりました。
- Doctorは`~/.openclaw/cron/jobs.json`（または`cron.store`）のレガシーcronジョブ形式もスキャンし、スケジューラがランタイムで自動正規化する前にその場で書き換えることができます。
- Doctorにはメモリ検索の準備状況チェックが含まれており、埋め込み認証情報が不足している場合は`openclaw configure --section model`を推奨できます。
- サンドボックスモードが有効でDockerが利用できない場合、Doctorは修復手順付きの重要度の高い警告を報告します（`Dockerをインストール`または`openclaw config set agents.defaults.sandbox.mode off`）。
- `gateway.auth.token`/`gateway.auth.password`がSecretRef管理でありかつ現在のコマンドパスで利用できない場合、Doctorは読み取り専用の警告を報告し、プレーンテキストのフォールバック認証情報は書き込みません。
- チャネルのSecretRef検査が修正パスで失敗した場合、Doctorは早期終了せずに続行し警告を報告します。
- Telegramの`allowFrom`ユーザー名自動解決（`doctor --fix`）には、現在のコマンドパスで解決可能なTelegramトークンが必要です。トークン検査が利用できない場合、Doctorは警告を報告し、そのパスの自動解決をスキップします。

## macOS: `launchctl`環境変数のオーバーライド

以前`launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`（または`...PASSWORD`）を実行した場合、その値が設定ファイルをオーバーライドし、永続的な「unauthorized」エラーの原因となることがあります。

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
