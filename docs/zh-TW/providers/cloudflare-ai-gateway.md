---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway 設定（驗證＋模型選擇）"
read_when:
  - 你想要將 Cloudflare AI Gateway 與 OpenClaw 一起使用
  - You need the account ID, gateway ID, or API key env var
---

# Cloudflare AI Gateway

Cloudflare AI Gateway 位於提供者 API 的前端，讓你新增分析、快取與控制功能。對於 Anthropic，OpenClaw 會透過你的 Gateway 端點使用 Anthropic Messages API。 1. 對於 Anthropic，OpenClaw 會透過你的 Gateway 端點使用 Anthropic Messages API。

- 提供者：`cloudflare-ai-gateway`
- 基礎 URL：`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- 預設模型：`cloudflare-ai-gateway/claude-sonnet-4-5`
- API 金鑰：`CLOUDFLARE_AI_GATEWAY_API_KEY`（透過 Gateway 發送請求時所使用的提供者 API 金鑰）

對於 Anthropic 模型，請使用你的 Anthropic API 金鑰。

## 快速開始

1. 設定提供者 API 金鑰與 Gateway 詳細資訊：

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

如果你在 Cloudflare 中啟用了 Gateway 驗證，請加入 `cf-aig-authorization` 標頭（這是在你的提供者 API 金鑰之外另外加入的）。

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

如果 Gateway 以常駐服務（launchd/systemd）方式執行，請確保 `CLOUDFLARE_AI_GATEWAY_API_KEY` 對該程序可用（例如，於 `~/.openclaw/.env` 中或透過 `env.shellEnv`）。
