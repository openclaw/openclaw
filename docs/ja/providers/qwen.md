---
summary: "OpenClaw で Qwen の OAuth（無料枠）を使用します"
read_when:
  - OpenClaw で Qwen を使用したい場合
  - Qwen Coder への無料枠 OAuth アクセスを利用したい場合
title: "Qwen"
---

# Qwen

Qwen は、Qwen Coder および Qwen Vision モデル向けに無料枠の OAuth フローを提供しています
（1 日あたり 2,000 リクエスト、Qwen のレート制限の対象）。

## プラグインを有効化

```bash
openclaw plugins enable qwen-portal-auth
```

有効化後、Gateway（ゲートウェイ）を再起動してください。

## 認証

```bash
openclaw models auth login --provider qwen-portal --set-default
```

これは Qwen のデバイスコード OAuth フローを実行し、プロバイダーエントリーを
`models.json` に書き込みます（クイック切り替え用の `qwen` エイリアスも追加されます）。

## モデル ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

モデルの切り替えは次のコマンドを使用します。

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI のログインを再利用

すでに Qwen Code CLI でログインしている場合、OpenClaw は認証ストアの読み込み時に
`~/.qwen/oauth_creds.json` から認証情報を同期します。それでも
`models.providers.qwen-portal` エントリーは必要です（上記のログインコマンドを使用して作成してください）。
`models.providers.qwen-portal` エントリが必要です（上記のログインコマンドを使用して作成します）。

## 注記

- トークンが自動的に更新されます。リフレッシュに失敗するか、アクセスが取り消された場合はログインコマンドを再実行します。
- デフォルトのベース URL：`https://portal.qwen.ai/v1`（Qwen が別のエンドポイントを提供する場合は
  `models.providers.qwen-portal.baseUrl` で上書きしてください）。
- プロバイダー共通のルールについては、[Model providers](/concepts/model-providers) を参照してください。
