---
summary: "Cách ứng dụng mac nhúng WebChat của Gateway và cách gỡ lỗi"
read_when:
  - Gỡ lỗi chế độ xem WebChat trên mac hoặc cổng loopback
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:43Z
---

# WebChat (ứng dụng macOS)

Ứng dụng thanh menu macOS nhúng giao diện WebChat như một chế độ xem SwiftUI gốc. Ứng dụng
kết nối tới Gateway và mặc định dùng **phiên chính** cho tác tử đã chọn
(với bộ chuyển phiên cho các phiên khác).

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
- Phiên: mặc định là phiên chính (`main`, hoặc `global` khi phạm vi là
  toàn cục). Giao diện có thể chuyển đổi giữa các phiên.
- Hướng dẫn ban đầu dùng một phiên riêng để tách thiết lập lần chạy đầu tiên.

## Bề mặt bảo mật

- Chế độ từ xa chỉ chuyển tiếp cổng điều khiển WebSocket của Gateway qua SSH.

## Hạn chế đã biết

- Giao diện được tối ưu cho các phiên trò chuyện (không phải sandbox trình duyệt đầy đủ).
