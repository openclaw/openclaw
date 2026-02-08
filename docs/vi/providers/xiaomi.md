---
summary: "Sử dụng Xiaomi MiMo (mimo-v2-flash) với OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình Xiaomi MiMo trong OpenClaw
  - Bạn cần thiết lập XIAOMI_API_KEY
title: "Xiaomi MiMo"
x-i18n:
  source_path: providers/xiaomi.md
  source_hash: 366fd2297b2caf8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:55Z
---

# Xiaomi MiMo

Xiaomi MiMo là nền tảng API cho các mô hình **MiMo**. Nền tảng này cung cấp các REST API tương thích với
định dạng OpenAI và Anthropic, đồng thời sử dụng khóa API để xác thực. Tạo khóa API của bạn trong
[Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). OpenClaw sử dụng
nhà cung cấp `xiaomi` với khóa API Xiaomi MiMo.

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
