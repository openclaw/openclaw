---
title: Cloudflare AI Gateway
summary: Cloudflare AI Gateway setup (auth + model selection)
read_when:
  - You want to use Cloudflare AI Gateway with OpenClaw
  - "You need the account ID, gateway ID, or API key env var"
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 位於供應商 API 之前，讓你可以新增分析、快取和控管功能。對於 Anthropic，OpenClaw 透過你的 Gateway 端點使用 Anthropic Messages API。

- 供應商：`cloudflare-ai-gateway`
- 基本 URL：`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 預設模型：`cloudflare-ai-gateway/claude-sonnet-4-5`
- API 金鑰：`CLOUDFLARE_AI_GATEWAY_API_KEY`（你用於透過 Gateway 發送請求的供應商 API 金鑰）

對於 Anthropic 模型，請使用你的 Anthropic API 金鑰。

## 快速開始

1. 設定供應商 API 金鑰和 Gateway 詳細資訊：

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. 設定預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## 非互動範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 已驗證的 Gateway

如果你在 Cloudflare 啟用了 Gateway 驗證，請加入 `cf-aig-authorization` 標頭（這是除了你的供應商 API 金鑰之外的額外設定）。

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

## 環境說明

如果 Gateway 以守護程序（launchd/systemd）方式執行，請確保該程序能取得 `CLOUDFLARE_AI_GATEWAY_API_KEY`（例如，在 `~/.openclaw/.env` 中或透過 `env.shellEnv`）。
