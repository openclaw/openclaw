---
summary: "Tham chiếu CLI cho `openclaw doctor` (kiểm tra sức khỏe + sửa lỗi có hướng dẫn)"
read_when:
  - Bạn gặp vấn đề kết nối/xác thực và muốn có cách khắc phục có hướng dẫn
  - Bạn vừa cập nhật và muốn kiểm tra nhanh
title: "doctor"
---

# `openclaw doctor`

Kiểm tra sức khỏe + sửa lỗi nhanh cho gateway và các kênh.

Liên quan:

- Xử lý sự cố: [Troubleshooting](/gateway/troubleshooting)
- Kiểm tra bảo mật: [Security](/gateway/security)

## Ví dụ

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Ghi chú:

- Các prompt tương tác (như sửa keychain/OAuth) chỉ chạy khi stdin là TTY và **không** đặt `--non-interactive`. Các lần chạy không có giao diện (cron, Telegram, không có terminal) sẽ bỏ qua các lời nhắc.
- `--fix` (bí danh của `--repair`) ghi một bản sao lưu vào `~/.openclaw/openclaw.json.bak` và loại bỏ các khóa cấu hình không xác định, liệt kê từng mục bị loại bỏ.

## macOS: ghi đè biến môi trường `launchctl`

Nếu trước đây bạn đã chạy `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (hoặc `...PASSWORD`), giá trị đó sẽ ghi đè tệp cấu hình của bạn và có thể gây ra lỗi “unauthorized” kéo dài.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
