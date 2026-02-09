---
summary: "Theo dõi thời hạn OAuth cho các nhà cung cấp mô hình"
read_when:
  - Thiết lập giám sát hoặc cảnh báo hết hạn xác thực
  - Tự động hóa kiểm tra làm mới OAuth cho Claude Code / Codex
title: "Giám sát xác thực"
---

# Giám sát xác thực

OpenClaw hiển thị tình trạng hết hạn OAuth thông qua `openclaw models status`. Hãy dùng điều này cho tự động hóa và cảnh báo; các script là phần bổ sung tùy chọn cho các quy trình làm việc trên điện thoại.

## Ưu tiên: kiểm tra bằng CLI (đa nền tảng)

```bash
openclaw models status --check
```

Mã thoát:

- `0`: OK
- `1`: thông tin xác thực đã hết hạn hoặc bị thiếu
- `2`: sắp hết hạn (trong vòng 24 giờ)

Cách này hoạt động với cron/systemd và không cần script bổ sung.

## Script tùy chọn (ops / quy trình điện thoại)

Chúng nằm trong `scripts/` và là **tùy chọn**. Chúng giả định có quyền truy cập SSH vào máy chủ gateway và được tinh chỉnh cho systemd + Termux.

- `scripts/claude-auth-status.sh` hiện dùng `openclaw models status --json` làm
  nguồn sự thật (dự phòng bằng cách đọc trực tiếp file nếu CLI không khả dụng),
  vì vậy hãy giữ `openclaw` trên `PATH` cho các timer.
- `scripts/auth-monitor.sh`: mục tiêu cron/systemd timer; gửi cảnh báo (ntfy hoặc điện thoại).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd user timer.
- `scripts/claude-auth-status.sh`: trình kiểm tra xác thực Claude Code + OpenClaw (đầy đủ/json/đơn giản).
- `scripts/mobile-reauth.sh`: quy trình tái xác thực có hướng dẫn qua SSH.
- `scripts/termux-quick-auth.sh`: widget một chạm hiển thị trạng thái + mở URL xác thực.
- `scripts/termux-auth-widget.sh`: quy trình widget có hướng dẫn đầy đủ.
- `scripts/termux-sync-widget.sh`: đồng bộ thông tin xác thực Claude Code → OpenClaw.

Nếu bạn không cần tự động hóa trên điện thoại hoặc timer systemd, hãy bỏ qua các script này.
