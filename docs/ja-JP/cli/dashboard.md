---
read_when:
    - 現在のトークンでControl UIを開きたい場合
    - ブラウザを起動せずにURLを表示したい場合
summary: '`openclaw dashboard`（Control UIを開く）のCLIリファレンス'
title: dashboard
x-i18n:
    generated_at: "2026-04-02T07:33:16Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a34cd109a3803e2910fcb4d32f2588aa205a4933819829ef5598f0780f586c94
    source_path: cli/dashboard.md
    workflow: 15
---

# `openclaw dashboard`

現在の認証情報を使用してControl UIを開きます。

```bash
openclaw dashboard
openclaw dashboard --no-open
```

注意事項:

- `dashboard` は設定された `gateway.auth.token` のSecretRefを可能な場合に解決します。
- SecretRef管理のトークン（解決済みまたは未解決）の場合、`dashboard` はターミナル出力、クリップボード履歴、またはブラウザ起動引数に外部シークレットが露出しないよう、トークンを含まないURLを表示/コピー/オープンします。
- `gateway.auth.token` がSecretRef管理されているがこのコマンドパスで未解決の場合、コマンドは無効なトークンプレースホルダーを埋め込む代わりに、トークンを含まないURLと明示的な修正ガイダンスを表示します。
