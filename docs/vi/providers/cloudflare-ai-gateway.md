---
title: "Cloudflare AI Gateway"
summary: "Thiết lập Cloudflare AI Gateway (xác thực + chọn mô hình)"
read_when:
  - Bạn muốn dùng Cloudflare AI Gateway với OpenClaw
  - Bạn cần account ID, gateway ID, hoặc biến môi trường API key
---

# Cloudflare AI Gateway

Cloudflare AI Gateway nằm phía trước các API của nhà cung cấp và cho phép bạn thêm phân tích, lưu bộ đệm và các biện pháp kiểm soát. Đối với Anthropic, OpenClaw sử dụng Anthropic Messages API thông qua endpoint Gateway của bạn.

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-5`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY` (khóa API của nhà cung cấp cho các yêu cầu đi qua Gateway)

Với các mô hình Anthropic, hãy dùng khóa API Anthropic của bạn.

## Quick start

1. Đặt khóa API của nhà cung cấp và chi tiết Gateway:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Đặt mô hình mặc định:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Authenticated gateways

Nếu bạn đã bật xác thực Gateway trong Cloudflare, hãy thêm header `cf-aig-authorization` (ngoài khóa API của nhà cung cấp).

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

## Environment note

Nếu Gateway chạy như một daemon (launchd/systemd), hãy đảm bảo `CLOUDFLARE_AI_GATEWAY_API_KEY` khả dụng cho tiến trình đó (ví dụ, trong `~/.openclaw/.env` hoặc qua `env.shellEnv`).
