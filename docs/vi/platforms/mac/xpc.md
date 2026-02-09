---
summary: "Kiến trúc IPC trên macOS cho ứng dụng OpenClaw, truyền tải node của Gateway và PeekabooBridge"
read_when:
  - Chỉnh sửa các hợp đồng IPC hoặc IPC của ứng dụng menu bar
title: "IPC trên macOS"
---

# Kiến trúc IPC OpenClaw trên macOS

**Current model:** a local Unix socket connects the **node host service** to the **macOS app** for exec approvals + `system.run`. A `openclaw-mac` debug CLI exists for discovery/connect checks; agent actions still flow through the Gateway WebSocket and `node.invoke`. UI automation uses PeekabooBridge.

## Mục tiêu

- Một phiên bản ứng dụng GUI duy nhất sở hữu toàn bộ công việc liên quan TCC (thông báo, ghi màn hình, mic, giọng nói, AppleScript).
- Bề mặt tự động hóa nhỏ gọn: Gateway + các lệnh node, cùng PeekabooBridge cho tự động hóa UI.
- Quyền hạn có thể dự đoán: luôn cùng bundle ID đã ký, được launchd khởi chạy, để các cấp TCC được giữ nguyên.

## Cách hoạt động

### Gateway + truyền tải node

- Ứng dụng chạy Gateway (chế độ local) và kết nối tới nó như một node.
- Các hành động của agent được thực hiện qua `node.invoke` (ví dụ: `system.run`, `system.notify`, `canvas.*`).

### IPC giữa dịch vụ node + ứng dụng

- Một dịch vụ node host không giao diện kết nối tới WebSocket của Gateway.
- Các yêu cầu `system.run` được chuyển tiếp tới ứng dụng macOS qua một Unix socket cục bộ.
- Ứng dụng thực thi exec trong ngữ cảnh UI, hiển thị prompt nếu cần, và trả về đầu ra.

Sơ đồ (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (tự động hóa UI)

- Tự động hóa UI sử dụng một UNIX socket riêng có tên `bridge.sock` và giao thức JSON của PeekabooBridge.
- Thứ tự ưu tiên host (phía client): Peekaboo.app → Claude.app → OpenClaw.app → thực thi cục bộ.
- Bảo mật: các bridge host yêu cầu TeamID nằm trong danh sách cho phép; lối thoát cùng UID chỉ cho DEBUG được bảo vệ bởi `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (quy ước của Peekaboo).
- Xem: [Cách dùng PeekabooBridge](/platforms/mac/peekaboo) để biết chi tiết.

## Luồng vận hành

- Khởi động lại/xây dựng lại: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Dừng các phiên bản đang chạy
  - Build Swift + đóng gói
  - Ghi/khởi tạo/kickstart LaunchAgent
- Phiên bản đơn: ứng dụng thoát sớm nếu phát hiện một phiên bản khác với cùng bundle ID đang chạy.

## Ghi chú tăng cường bảo mật

- Ưu tiên yêu cầu khớp TeamID cho mọi bề mặt có đặc quyền.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (chỉ DEBUG) có thể cho phép caller cùng UID cho phát triển cục bộ.
- Mọi giao tiếp đều chỉ cục bộ; không mở socket mạng.
- Các prompt TCC chỉ xuất phát từ bundle GUI; giữ bundle ID đã ký ổn định giữa các lần rebuild.
- Gia cố IPC: chế độ socket `0600`, token, kiểm tra peer-UID, thử thách/đáp ứng HMAC, TTL ngắn.
