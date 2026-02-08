---
summary: "Tham chiếu CLI cho `openclaw health` (điểm cuối tình trạng Gateway qua RPC)"
read_when:
  - Bạn muốn nhanh chóng kiểm tra tình trạng của Gateway đang chạy
title: "health"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:17Z
---

# `openclaw health`

Lấy thông tin tình trạng từ Gateway đang chạy.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Ghi chú:

- `--verbose` chạy các probe trực tiếp và in thời gian theo từng tài khoản khi có nhiều tài khoản được cấu hình.
- Đầu ra bao gồm các kho lưu trữ phiên theo từng tác tử khi có nhiều tác tử được cấu hình.
