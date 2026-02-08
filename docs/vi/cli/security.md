---
summary: "Tham chiếu CLI cho `openclaw security` (kiểm tra và khắc phục các lỗi bảo mật thường gặp)"
read_when:
  - Bạn muốn chạy kiểm tra bảo mật nhanh cho cấu hình/trạng thái
  - Bạn muốn áp dụng các gợi ý “sửa” an toàn (chmod, siết chặt mặc định)
title: "security"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:21Z
---

# `openclaw security`

Công cụ bảo mật (kiểm tra + tùy chọn sửa).

Liên quan:

- Hướng dẫn bảo mật: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

Bản kiểm tra sẽ cảnh báo khi nhiều người gửi DM dùng chung phiên chính và khuyến nghị **chế độ DM an toàn**: `session.dmScope="per-channel-peer"` (hoặc `per-account-channel-peer` cho các kênh đa tài khoản) cho hộp thư đến dùng chung.
Nó cũng cảnh báo khi các mô hình nhỏ (`<=300B`) được sử dụng mà không có sandboxing và bật công cụ web/trình duyệt.
