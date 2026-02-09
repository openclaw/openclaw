---
summary: "Cách ứng dụng mac nhúng WebChat của Gateway và cách gỡ lỗi"
read_when:
  - Gỡ lỗi chế độ xem WebChat trên mac hoặc cổng loopback
title: "WebChat"
---

# WebChat (ứng dụng macOS)

The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It
connects to the Gateway and defaults to the **main session** for the selected
agent (with a session switcher for other sessions).

- **Chế độ cục bộ**: kết nối trực tiếp tới WebSocket Gateway cục bộ.
- **Chế độ từ xa**: chuyển tiếp cổng điều khiển Gateway qua SSH và dùng
  đường hầm đó làm mặt phẳng dữ liệu.

## Khởi chạy & gỡ lỗi

- Thủ công: menu Lobster → “Open Chat”.

- Tự động mở để kiểm thử:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Nhật ký: `./scripts/clawlog.sh` (phân hệ `bot.molt`, danh mục `WebChatSwiftUI`).

## Cách kết nối

- Mặt phẳng dữ liệu: các phương thức WS của Gateway `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` và các sự kiện `chat`, `agent`, `presence`, `tick`, `health`.
- Session: defaults to the primary session (`main`, or `global` when scope is
  global). The UI can switch between sessions.
- Hướng dẫn ban đầu dùng một phiên riêng để tách thiết lập lần chạy đầu tiên.

## Bề mặt bảo mật

- Chế độ từ xa chỉ chuyển tiếp cổng điều khiển WebSocket của Gateway qua SSH.

## Hạn chế đã biết

- Giao diện được tối ưu cho các phiên trò chuyện (không phải sandbox trình duyệt đầy đủ).
