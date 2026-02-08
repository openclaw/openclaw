---
summary: "Sử dụng OpenCode Zen (các mô hình được tuyển chọn) với OpenClaw"
read_when:
  - Bạn muốn OpenCode Zen để truy cập mô hình
  - Bạn muốn danh sách mô hình được tuyển chọn, thân thiện với lập trình
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:55Z
---

# OpenCode Zen

OpenCode Zen là **danh sách các mô hình được tuyển chọn** do đội ngũ OpenCode đề xuất cho các tác tử lập trình.
Đây là một tùy chọn truy cập mô hình được lưu trữ, sử dụng khóa API và nhà cung cấp `opencode`.
Zen hiện đang ở giai đoạn beta.

## Thiết lập CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Đoạn cấu hình

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Ghi chú

- `OPENCODE_ZEN_API_KEY` cũng được hỗ trợ.
- Bạn đăng nhập vào Zen, thêm thông tin thanh toán và sao chép khóa API của mình.
- OpenCode Zen tính phí theo từng yêu cầu; hãy kiểm tra bảng điều khiển OpenCode để biết chi tiết.
