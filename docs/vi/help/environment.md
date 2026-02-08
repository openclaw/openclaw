---
summary: "Nơi OpenClaw tải các biến môi trường và thứ tự ưu tiên"
read_when:
  - Bạn cần biết những biến môi trường nào được tải và theo thứ tự nào
  - Bạn đang gỡ lỗi các khóa API bị thiếu trong Gateway
  - Bạn đang lập tài liệu xác thực nhà cung cấp hoặc môi trường triển khai
title: "Biến môi trường"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:08Z
---

# Biến môi trường

OpenClaw lấy các biến môi trường từ nhiều nguồn. Quy tắc là **không bao giờ ghi đè các giá trị hiện có**.

## Thứ tự ưu tiên (cao nhất → thấp nhất)

1. **Môi trường của tiến trình** (những gì tiến trình Gateway đã có từ shell/daemon cha).
2. **`.env` trong thư mục làm việc hiện tại** (mặc định của dotenv; không ghi đè).
3. **`.env` toàn cục** tại `~/.openclaw/.env` (còn gọi là `$OPENCLAW_STATE_DIR/.env`; không ghi đè).
4. **Khối cấu hình `env`** trong `~/.openclaw/openclaw.json` (chỉ áp dụng nếu còn thiếu).
5. **Nhập từ login-shell tùy chọn** (`env.shellEnv.enabled` hoặc `OPENCLAW_LOAD_SHELL_ENV=1`), chỉ áp dụng cho các khóa mong đợi còn thiếu.

Nếu tệp cấu hình bị thiếu hoàn toàn, bước 4 sẽ bị bỏ qua; việc nhập từ shell vẫn chạy nếu được bật.

## Khối cấu hình `env`

Hai cách tương đương để đặt biến môi trường nội tuyến (cả hai đều không ghi đè):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Nhập biến môi trường từ shell

`env.shellEnv` chạy login shell của bạn và chỉ nhập các khóa mong đợi **còn thiếu**:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Các biến môi trường tương đương:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Thay thế biến môi trường trong cấu hình

Bạn có thể tham chiếu trực tiếp các biến môi trường trong giá trị chuỗi của cấu hình bằng cú pháp `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Xem [Cấu hình: Thay thế biến môi trường](/gateway/configuration#env-var-substitution-in-config) để biết đầy đủ chi tiết.

## Liên quan

- [Cấu hình Gateway](/gateway/configuration)
- [FAQ: biến môi trường và tải .env](/help/faq#env-vars-and-env-loading)
- [Tổng quan mô hình](/concepts/models)
