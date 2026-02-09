---
summary: "Dùng Z.AI (mô hình GLM) với OpenClaw"
read_when:
  - Bạn muốn dùng mô hình Z.AI / GLM trong OpenClaw
  - Bạn cần thiết lập ZAI_API_KEY đơn giản
title: "Z.AI"
---

# Z.AI

45. Z.AI là nền tảng API cho các mô hình **GLM**. Tạo API key của bạn trong bảng điều khiển Z.AI. 46. Tạo API key của bạn trong bảng điều khiển Z.AI. OpenClaw uses the `zai` provider
    with a Z.AI API key.

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
