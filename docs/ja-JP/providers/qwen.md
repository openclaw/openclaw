---
summary: "OpenClawでQwen OAuth（無料枠）を使用する"
read_when:
  - OpenClawでQwenを使いたい場合
  - Qwen Coderへの無料枠OAuthアクセスが欲しい場合
title: "Qwen"
---

# Qwen

Qwenはリクエスト2,000件/日（Qwenのレートリミットが適用されます）の無料枠OAuthフローをQwen CoderおよびQwen Visionモデルに提供しています。

## プラグインを有効にする

```bash
openclaw plugins enable qwen-portal-auth
```

有効にした後、Gatewayを再起動してください。

## 認証

```bash
openclaw models auth login --provider qwen-portal --set-default
```

これによりQwenデバイスコードOAuthフローが実行され、プロバイダーエントリが `models.json` に書き込まれます（クイック切り替え用の `qwen` エイリアスも含む）。

## モデルID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

モデルを切り替えるには:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLIログインの再利用

Qwen Code CLIですでにログインしている場合、OpenClawは認証ストアを読み込む際に `~/.qwen/oauth_creds.json` からクレデンシャルを同期します。`models.providers.qwen-portal` エントリが引き続き必要です（上記のログインコマンドで作成してください）。

## 注意事項

- トークンは自動更新されます。更新が失敗したりアクセスが取り消された場合はログインコマンドを再実行してください。
- デフォルトのベースURL: `https://portal.qwen.ai/v1`（Qwenが別のエンドポイントを提供する場合は `models.providers.qwen-portal.baseUrl` でオーバーライドしてください）。
- プロバイダー全体のルールについては [モデルプロバイダー](/concepts/model-providers) を参照してください。
