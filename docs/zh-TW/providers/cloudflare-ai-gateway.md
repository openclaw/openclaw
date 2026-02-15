---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway 設定 (憑證 + 模型選擇)"
read_when:
  - 您想將 Cloudflare AI Gateway 與 OpenClaw 搭配使用
  - 您需要帳戶 ID、Gateway ID 或 API 金鑰環境變數
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 位於供應商 API 前方，可讓您新增分析、快取和控制項。對於 Anthropic，OpenClaw 透過您的 Gateway 端點使用 Anthropic Messages API。

- 供應商: `cloudflare-ai-gateway`
- 基本 URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 預設模型: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API 金鑰: `CLOUDFLARE_AI_GATEWAY_API_KEY` (您透過 Gateway 請求的供應商 API 金鑰)

對於 Anthropic 模型，請使用您的 Anthropic API 金鑰。

## 快速開始

1. 設定供應商 API 金鑰和 Gateway 詳細資訊:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. 設定預設模型:

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

如果您在 Cloudflare 中啟用 Gateway 驗證，請新增 `cf-aig-authorization` 標頭 (這是在您的供應商 API 金鑰之外新增的)。

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

## 環境注意事項

如果 Gateway 以守護程式 (launchd/systemd) 執行，請確保該程序可以使用 `CLOUDFLARE_AI_GATEWAY_API_KEY` (例如，在 `~/.openclaw/.env` 或透過 `env.shellEnv`)。
