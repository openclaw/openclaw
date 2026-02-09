---
summary: "Tham chiếu CLI cho `openclaw security` (kiểm tra và khắc phục các lỗi bảo mật thường gặp)"
read_when:
  - Bạn muốn chạy kiểm tra bảo mật nhanh cho cấu hình/trạng thái
  - Bạn muốn áp dụng các gợi ý “sửa” an toàn (chmod, siết chặt mặc định)
title: "security"
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

Bản audit cảnh báo khi nhiều người gửi DM chia sẻ cùng phiên chính và khuyến nghị **chế độ DM an toàn**: `session.dmScope="per-channel-peer"` (hoặc `per-account-channel-peer` cho các kênh đa tài khoản) cho các hộp thư đến dùng chung.
Xếp hàng một sự kiện hệ thống vào phiên **main**.
