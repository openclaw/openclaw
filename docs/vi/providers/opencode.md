---
summary: "Sử dụng OpenCode Zen (các mô hình được tuyển chọn) với OpenClaw"
read_when:
  - Bạn muốn OpenCode Zen để truy cập mô hình
  - Bạn muốn danh sách mô hình được tuyển chọn, thân thiện với lập trình
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
24. Zen hiện đang ở giai đoạn beta.

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
