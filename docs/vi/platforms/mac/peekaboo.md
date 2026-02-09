---
summary: "Tích hợp PeekabooBridge cho tự động hóa UI trên macOS"
read_when:
  - Lưu trữ PeekabooBridge trong OpenClaw.app
  - Tích hợp Peekaboo qua Swift Package Manager
  - Thay đổi giao thức/đường dẫn PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (tự động hóa UI trên macOS)

OpenClaw có thể host **PeekabooBridge** như một broker tự động hóa UI cục bộ, có nhận thức về quyền. Điều này cho phép CLI `peekaboo` điều khiển tự động hóa UI trong khi tái sử dụng các quyền TCC của ứng dụng macOS.

## Đây là gì (và không phải là gì)

- **Host**: OpenClaw.app có thể hoạt động như một host PeekabooBridge.
- **Client**: sử dụng CLI `peekaboo` (không có bề mặt `openclaw ui ...` riêng).
- **UI**: các lớp phủ trực quan vẫn nằm trong Peekaboo.app; OpenClaw là một host broker mỏng.

## Bật bridge

Trong ứng dụng macOS:

- Settings → **Enable Peekaboo Bridge**

When enabled, OpenClaw starts a local UNIX socket server. If disabled, the host
is stopped and `peekaboo` will fall back to other available hosts.

## Thứ tự khám phá client

Các client Peekaboo thường thử các host theo thứ tự sau:

1. Peekaboo.app (UX đầy đủ)
2. Claude.app (nếu được cài đặt)
3. OpenClaw.app (broker mỏng)

Use `peekaboo bridge status --verbose` to see which host is active and which
socket path is in use. You can override with:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Bảo mật & quyền

- Bridge xác thực **chữ ký mã của bên gọi**; áp dụng danh sách cho phép các TeamID (TeamID của host Peekaboo + TeamID của ứng dụng OpenClaw).
- Yêu cầu sẽ hết thời gian chờ sau khoảng ~10 giây.
- Nếu thiếu các quyền cần thiết, bridge trả về thông báo lỗi rõ ràng thay vì mở System Settings.

## Hành vi snapshot (tự động hóa)

Snapshots are stored in memory and expire automatically after a short window.
If you need longer retention, re‑capture from the client.

## Xử lý sự cố

- Nếu `peekaboo` báo “bridge client is not authorized”, hãy đảm bảo client được ký đúng cách hoặc chạy host với `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` chỉ trong chế độ **debug**.
- Nếu không tìm thấy host nào, hãy mở một trong các ứng dụng host (Peekaboo.app hoặc OpenClaw.app) và xác nhận các quyền đã được cấp.
