---
summary: "Dùng API hợp nhất của OpenRouter để truy cập nhiều mô hình trong OpenClaw"
read_when:
  - Bạn muốn một khóa API duy nhất cho nhiều LLM
  - Bạn muốn chạy các mô hình qua OpenRouter trong OpenClaw
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Thiết lập CLI

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

## Đoạn cấu hình

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

## Ghi chú

- Tham chiếu mô hình là `openrouter/<provider>/<model>`.
- Để biết thêm tùy chọn mô hình/nhà cung cấp, xem [/concepts/model-providers](/concepts/model-providers).
- OpenRouter sử dụng Bearer token với khóa API của bạn ở phía dưới.
