---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway のセットアップ（認証 + モデル選択）"
read_when:
  - OpenClaw で Cloudflare AI Gateway を使用したい場合
  - アカウント ID、ゲートウェイ ID、または API キーの環境変数が必要な場合
---

# Cloudflare AI Gateway

Cloudflare AI Gateway はプロバイダー API の前段に配置され、分析、キャッシュ、制御を追加できます。Anthropic の場合、OpenClaw はゲートウェイ エンドポイントを介して Anthropic Messages API を使用します。 Anthropicの場合、OpenClawはゲートウェイエンドポイントを介してAnthropic Messages APIを使用します。

- プロバイダー: `cloudflare-ai-gateway`
- ベース URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- デフォルト モデル: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API キー: `CLOUDFLARE_AI_GATEWAY_API_KEY`（ゲートウェイ経由のリクエストに使用するプロバイダーの API キー）

Anthropic モデルでは、Anthropic の API キーを使用してください。

## クイックスタート

1. プロバイダーの API キーとゲートウェイの詳細を設定します。

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. デフォルトのモデルを設定します。

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 認証されたゲートウェイ

Cloudflare でゲートウェイ認証を有効にしている場合は、`cf-aig-authorization` ヘッダーを追加してください（これはプロバイダーの API キーに加えて必要です）。

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

## 環境に関する注記

ゲートウェイがデーモン（launchd/systemd）として実行されている場合は、`CLOUDFLARE_AI_GATEWAY_API_KEY` がそのプロセスから利用可能であることを確認してください（例えば、`~/.openclaw/.env` に設定するか、`env.shellEnv` を使用します）。
