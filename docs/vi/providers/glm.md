---
summary: "Tổng quan họ mô hình GLM + cách sử dụng trong OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình GLM trong OpenClaw
  - Bạn cần quy ước đặt tên mô hình và cách thiết lập
title: "Các mô hình GLM"
---

# Các mô hình GLM

GLM is a **model family** (not a company) available through the Z.AI platform. Trong OpenClaw, các mô hình GLM
được truy cập thông qua nhà cung cấp `zai` và các ID mô hình như `zai/glm-4.7`.

## Thiết lập CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Đoạn cấu hình

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Ghi chú

- Phiên bản và mức độ khả dụng của GLM có thể thay đổi; hãy kiểm tra tài liệu của Z.AI để biết thông tin mới nhất.
- Ví dụ ID mô hình bao gồm `glm-4.7` và `glm-4.6`.
- Để biết chi tiết về nhà cung cấp, xem [/providers/zai](/providers/zai).
