---
summary: "Dùng API hợp nhất của OpenRouter để truy cập nhiều mô hình trong OpenClaw"
read_when:
  - Bạn muốn một khóa API duy nhất cho nhiều LLM
  - Bạn muốn chạy các mô hình qua OpenRouter trong OpenClaw
title: "OpenRouter"
x-i18n:
  source_path: providers/openrouter.md
  source_hash: b7e29fc9c456c64d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:54Z
---

# OpenRouter

OpenRouter cung cấp một **API hợp nhất** định tuyến các yêu cầu tới nhiều mô hình phía sau một
endpoint và khóa API duy nhất. API này tương thích OpenAI, nên hầu hết các SDK OpenAI hoạt động chỉ bằng cách đổi base URL.

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
