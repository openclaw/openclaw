---
summary: "Lưu trữ tĩnh WebChat dạng loopback và cách dùng Gateway WS cho giao diện chat"
read_when:
  - Khi gỡ lỗi hoặc cấu hình quyền truy cập WebChat
title: "WebChat"
x-i18n:
  source_path: web/webchat.md
  source_hash: b5ee2b462c8c979a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:40Z
---

# WebChat (Gateway WebSocket UI)

Trạng thái: giao diện chat SwiftUI trên macOS/iOS giao tiếp trực tiếp với Gateway WebSocket.

## WebChat là gì

- Giao diện chat native cho gateway (không nhúng trình duyệt và không có máy chủ tĩnh cục bộ).
- Sử dụng cùng các phiên và quy tắc định tuyến như các kênh khác.
- Định tuyến xác định: phản hồi luôn quay lại WebChat.

## Khởi động nhanh

1. Khởi động gateway.
2. Mở giao diện WebChat (ứng dụng macOS/iOS) hoặc tab chat của Control UI.
3. Đảm bảo xác thực gateway đã được cấu hình (mặc định là bắt buộc, kể cả trên local loopback).

## Cách hoạt động (hành vi)

- UI kết nối tới Gateway WebSocket và sử dụng `chat.history`, `chat.send` và `chat.inject`.
- `chat.inject` thêm một ghi chú của trợ lý trực tiếp vào bản ghi hội thoại và phát tới UI (không chạy agent).
- Lịch sử luôn được lấy từ gateway (không theo dõi tệp cục bộ).
- Nếu gateway không truy cập được, WebChat ở chế độ chỉ đọc.

## Sử dụng từ xa

- Chế độ từ xa tạo đường hầm Gateway WebSocket qua SSH/Tailscale.
- Bạn không cần chạy một máy chủ WebChat riêng.

## Tham chiếu cấu hình (WebChat)

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn kênh:

- Không có khối `webchat.*` riêng. WebChat sử dụng endpoint gateway + các thiết lập xác thực bên dưới.

Các tùy chọn toàn cục liên quan:

- `gateway.port`, `gateway.bind`: máy chủ/cổng WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: xác thực WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: đích gateway từ xa.
- `session.*`: lưu trữ phiên và các giá trị mặc định của khóa chính.
