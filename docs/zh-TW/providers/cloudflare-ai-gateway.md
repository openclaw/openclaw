---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway 設定（驗證 + 模型選擇）"
read_when:
  - 您想在 OpenClaw 中使用 Cloudflare AI Gateway 時
  - 您需要帳號 ID、Gateway ID 或 API 金鑰環境變數時
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 位於供應商 API 的前端，讓您可以加入分析、快取與控制功能。針對 Anthropic，OpenClaw 會透過您的 Gateway 端點使用 Anthropic Messages API。

- 供應商：`cloudflare-ai-gateway`
- 基礎 URL：`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 預設模型：`cloudflare-ai-gateway/claude-sonnet-4-5`
- API 金鑰：`CLOUDFLARE_AI_GATEWAY_API_KEY`（您透過 Gateway 發送請求時使用的供應商 API 金鑰）

對於 Anthropic 模型，請使用您的 Anthropic API 金鑰。

## 快速開始

1. 設定供應商 API 金鑰與 Gateway 詳細資訊：

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

## 非互動式範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## 已驗證的 Gateway

如果您在 Cloudflare 中啟用了 Gateway 驗證，請新增 `cf-aig-authorization` 標頭（這是除供應商 API 金鑰之外額外需要的）。

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

如果 Gateway 以服務（daemon，如 launchd/systemd）形式執行，請確保該程序可以存取 `CLOUDFLARE_AI_GATEWAY_API_KEY`（例如：在 `~/.openclaw/.env` 中或透過 `env.shellEnv` 設定）。
