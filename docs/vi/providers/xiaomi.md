---
summary: "Sử dụng Xiaomi MiMo (mimo-v2-flash) với OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình Xiaomi MiMo trong OpenClaw
  - Bạn cần thiết lập XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

43. Xiaomi MiMo là nền tảng API cho các mô hình **MiMo**. Tạo API key của bạn trong
    [Bảng điều khiển Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). 44. Tạo API key của bạn trong [bảng điều khiển Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). Z.AI là nền tảng API cho các mô hình **GLM**.

## Tổng quan mô hình

- **mimo-v2-flash**: cửa sổ ngữ cảnh 262144 token, tương thích với Anthropic Messages API.
- Base URL: `https://api.xiaomimimo.com/anthropic`
- Authorization: `Bearer $XIAOMI_API_KEY`

## Thiết lập CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Đoạn cấu hình

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Ghi chú

- Tham chiếu mô hình: `xiaomi/mimo-v2-flash`.
- Nhà cung cấp được tự động chèn khi `XIAOMI_API_KEY` được thiết lập (hoặc khi tồn tại hồ sơ xác thực).
- Xem [/concepts/model-providers](/concepts/model-providers) để biết các quy tắc về nhà cung cấp.
