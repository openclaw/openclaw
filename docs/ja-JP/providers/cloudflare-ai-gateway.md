---
read_when:
    - OpenClawでCloudflare AI Gatewayを使用したい場合
    - アカウントID、ゲートウェイID、またはAPIキーの環境変数が必要な場合
summary: Cloudflare AI Gatewayのセットアップ（認証 + モデル選択）
title: Cloudflare AI Gateway
x-i18n:
    generated_at: "2026-04-02T08:37:40Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8db62746f61eca6484485508d2bdb2b6667687e44d1127c00c31530fd8e09957
    source_path: providers/cloudflare-ai-gateway.md
    workflow: 15
---

# Cloudflare AI Gateway

Cloudflare AI Gatewayはプロバイダー APIの前段に配置され、分析、キャッシュ、制御を追加できます。Anthropicの場合、OpenClawはGateway ゲートウェイエンドポイントを通じてAnthropic Messages APIを使用します。

- プロバイダー: `cloudflare-ai-gateway`
- ベースURL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- デフォルトモデル: `cloudflare-ai-gateway/claude-sonnet-4-6`
- APIキー: `CLOUDFLARE_AI_GATEWAY_API_KEY`（Gateway ゲートウェイを通じたリクエスト用のプロバイダーAPIキー）

Anthropicモデルの場合は、Anthropic APIキーを使用してください。

## クイックスタート

1. プロバイダーAPIキーとGateway ゲートウェイの詳細を設定します:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-6" },
    },
  },
}
```

## 非対話式の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 認証付きゲートウェイ

CloudflareでGateway ゲートウェイの認証を有効にした場合、`cf-aig-authorization` ヘッダーを追加してください（プロバイダーAPIキーに加えて必要です）。

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行される場合、`CLOUDFLARE_AI_GATEWAY_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。
