---
summary: "Dùng Z.AI (mô hình GLM) với OpenClaw"
read_when:
  - Bạn muốn dùng mô hình Z.AI / GLM trong OpenClaw
  - Bạn cần thiết lập ZAI_API_KEY đơn giản
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:55Z
---

# Z.AI

Z.AI là nền tảng API cho các mô hình **GLM**. Nền tảng này cung cấp REST API cho GLM và sử dụng khóa API
để xác thực. Tạo khóa API của bạn trong bảng điều khiển Z.AI. OpenClaw sử dụng nhà cung cấp `zai` với
khóa API của Z.AI.

## CLI setup

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notes

- Các mô hình GLM có sẵn dưới dạng `zai/<model>` (ví dụ: `zai/glm-4.7`).
- Xem [/providers/glm](/providers/glm) để biết tổng quan về họ mô hình.
- Z.AI sử dụng xác thực Bearer với khóa API của bạn.
