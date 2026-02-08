---
summary: "Tích hợp PeekabooBridge cho tự động hóa UI trên macOS"
read_when:
  - Lưu trữ PeekabooBridge trong OpenClaw.app
  - Tích hợp Peekaboo qua Swift Package Manager
  - Thay đổi giao thức/đường dẫn PeekabooBridge
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:40Z
---

# Peekaboo Bridge (tự động hóa UI trên macOS)

OpenClaw có thể lưu trữ **PeekabooBridge** như một broker tự động hóa UI cục bộ, có nhận biết quyền. Điều này cho phép CLI `peekaboo` điều khiển tự động hóa UI trong khi tái sử dụng các quyền TCC của ứng dụng macOS.

## Đây là gì (và không phải là gì)

- **Host**: OpenClaw.app có thể hoạt động như một host PeekabooBridge.
- **Client**: sử dụng CLI `peekaboo` (không có bề mặt `openclaw ui ...` riêng).
- **UI**: các lớp phủ trực quan vẫn nằm trong Peekaboo.app; OpenClaw là một host broker mỏng.

## Bật bridge

Trong ứng dụng macOS:

- Settings → **Enable Peekaboo Bridge**

Khi được bật, OpenClaw khởi chạy một máy chủ socket UNIX cục bộ. Nếu bị tắt, host sẽ dừng và `peekaboo` sẽ chuyển sang các host khả dụng khác.

## Thứ tự khám phá client

Các client Peekaboo thường thử các host theo thứ tự sau:

1. Peekaboo.app (UX đầy đủ)
2. Claude.app (nếu được cài đặt)
3. OpenClaw.app (broker mỏng)

Sử dụng `peekaboo bridge status --verbose` để xem host nào đang hoạt động và đường dẫn socket đang được dùng. Bạn có thể ghi đè bằng:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Bảo mật & quyền

- Bridge xác thực **chữ ký mã của bên gọi**; áp dụng danh sách cho phép các TeamID (TeamID của host Peekaboo + TeamID của ứng dụng OpenClaw).
- Yêu cầu sẽ hết thời gian chờ sau khoảng ~10 giây.
- Nếu thiếu các quyền cần thiết, bridge trả về thông báo lỗi rõ ràng thay vì mở System Settings.

## Hành vi snapshot (tự động hóa)

Snapshot được lưu trong bộ nhớ và tự động hết hạn sau một khoảng ngắn. Nếu cần lưu lâu hơn, hãy chụp lại từ client.

## Xử lý sự cố

- Nếu `peekaboo` báo “bridge client is not authorized”, hãy đảm bảo client được ký đúng cách hoặc chạy host với `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` chỉ trong chế độ **debug**.
- Nếu không tìm thấy host nào, hãy mở một trong các ứng dụng host (Peekaboo.app hoặc OpenClaw.app) và xác nhận các quyền đã được cấp.
