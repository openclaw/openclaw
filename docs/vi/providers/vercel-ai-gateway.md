---
title: "Vercel AI Gateway"
summary: "Thiết lập Vercel AI Gateway (xác thực + chọn mô hình)"
read_when:
  - Bạn muốn dùng Vercel AI Gateway với OpenClaw
  - Bạn cần biến môi trường khóa API hoặc lựa chọn xác thực bằng CLI
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) cung cấp một API thống nhất để truy cập hàng trăm mô hình thông qua một endpoint duy nhất.

- Nhà cung cấp: `vercel-ai-gateway`
- Xác thực: `AI_GATEWAY_API_KEY`
- API: Tương thích Anthropic Messages

## Khởi động nhanh

1. Đặt khóa API (khuyến nghị: lưu cho Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Đặt mô hình mặc định:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Ví dụ không tương tác

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Lưu ý về môi trường

Nếu Gateway chạy như một daemon (launchd/systemd), hãy đảm bảo `AI_GATEWAY_API_KEY`
có sẵn cho tiến trình đó (ví dụ, trong `~/.openclaw/.env` hoặc thông qua
`env.shellEnv`).
