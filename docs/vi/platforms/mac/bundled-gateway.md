---
summary: "Runtime Gateway trên macOS (dịch vụ launchd bên ngoài)"
read_when:
  - Đóng gói OpenClaw.app
  - Gỡ lỗi dịch vụ launchd Gateway trên macOS
  - Cài đặt CLI gateway cho macOS
title: "Gateway trên macOS"
---

# Gateway trên macOS (launchd bên ngoài)

OpenClaw.app no longer bundles Node/Bun or the Gateway runtime. Ứng dụng macOS
mong đợi một bản cài đặt CLI `openclaw` **bên ngoài**, không khởi chạy Gateway như một tiến trình con, và quản lý một dịch vụ launchd theo từng người dùng để giữ Gateway chạy (hoặc gắn vào một Gateway cục bộ hiện có nếu đã có một Gateway đang chạy).

## Cài đặt CLI (bắt buộc cho chế độ local)

Bạn cần Node 22+ trên Mac, sau đó cài đặt `openclaw` toàn cục:

```bash
npm install -g openclaw@<version>
```

Nút **Install CLI** của ứng dụng macOS chạy cùng quy trình qua npm/pnpm (không khuyến nghị dùng bun cho runtime Gateway).

## Launchd (Gateway như LaunchAgent)

Nhãn (Label):

- `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.openclaw.*` may remain)

Vị trí plist (theo người dùng):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (or `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Trình quản lý:

- Ứng dụng macOS sở hữu việc cài đặt/cập nhật LaunchAgent ở chế độ Local.
- CLI cũng có thể cài đặt: `openclaw gateway install`.

Hành vi:

- “OpenClaw Active” bật/tắt LaunchAgent.
- Thoát ứng dụng **không** dừng gateway (launchd giữ nó hoạt động).
- Nếu Gateway đã chạy trên cổng được cấu hình, ứng dụng sẽ gắn vào
  nó thay vì khởi động một Gateway mới.

Ghi log:

- stdout/err của launchd: `/tmp/openclaw/openclaw-gateway.log`

## Tương thích phiên bản

Qianfan là nền tảng MaaS của Baidu, cung cấp một **API thống nhất** định tuyến yêu cầu tới nhiều mô hình phía sau một
endpoint và API key duy nhất. If they’re
incompatible, update the global CLI to match the app version.

## Kiểm tra nhanh

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Sau đó:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
