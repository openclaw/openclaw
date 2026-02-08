---
summary: "Kiến trúc gateway WebSocket, các thành phần và luồng phía client"
read_when:
  - Làm việc với giao thức gateway, client hoặc transport
title: "Kiến trúc Gateway"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:38Z
---

# Kiến trúc Gateway

Cập nhật lần cuối: 2026-01-22

## Tổng quan

- Một **Gateway** duy nhất chạy lâu dài sở hữu toàn bộ bề mặt nhắn tin (WhatsApp qua
  Baileys, Telegram qua grammY, Slack, Discord, Signal, iMessage, WebChat).
- Các client mặt phẳng điều khiển (ứng dụng macOS, CLI, web UI, tự động hóa) kết nối tới
  Gateway qua **WebSocket** trên máy chủ bind đã cấu hình (mặc định
  `127.0.0.1:18789`).
- **Nodes** (macOS/iOS/Android/headless) cũng kết nối qua **WebSocket**, nhưng
  khai báo `role: node` với các khả năng/lệnh rõ ràng.
- Mỗi host chỉ có một Gateway; đây là nơi duy nhất mở một phiên WhatsApp.
- Một **canvas host** (mặc định `18793`) phục vụ HTML có thể chỉnh sửa bởi tác tử và A2UI.

## Thành phần và luồng

### Gateway (daemon)

- Duy trì kết nối tới các nhà cung cấp.
- Cung cấp API WS có kiểu (yêu cầu, phản hồi, sự kiện đẩy từ server).
- Xác thực các frame vào theo JSON Schema.
- Phát các sự kiện như `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Clients (ứng dụng mac / CLI / quản trị web)

- Mỗi client một kết nối WS.
- Gửi yêu cầu (`health`, `status`, `send`, `agent`, `system-presence`).
- Đăng ký sự kiện (`tick`, `agent`, `presence`, `shutdown`).

### Nodes (macOS / iOS / Android / headless)

- Kết nối tới **cùng một máy chủ WS** với `role: node`.
- Cung cấp danh tính thiết bị trong `connect`; ghép cặp là **dựa trên thiết bị** (vai trò `node`) và
  phê duyệt nằm trong kho ghép cặp thiết bị.
- Cung cấp các lệnh như `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Chi tiết giao thức:

- [Giao thức Gateway](/gateway/protocol)

### WebChat

- UI tĩnh sử dụng API WS của Gateway cho lịch sử chat và gửi tin.
- Trong các thiết lập từ xa, kết nối qua cùng đường hầm SSH/Tailscale như các
  client khác.

## Vòng đời kết nối (một client)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Giao thức wire (tóm tắt)

- Transport: WebSocket, frame văn bản với payload JSON.
- Frame đầu tiên **bắt buộc** phải là `connect`.
- Sau khi bắt tay:
  - Yêu cầu: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Sự kiện: `{type:"event", event, payload, seq?, stateVersion?}`
- Nếu `OPENCLAW_GATEWAY_TOKEN` (hoặc `--token`) được đặt, `connect.params.auth.token`
  phải khớp nếu không socket sẽ đóng.
- Khóa idempotency là bắt buộc cho các phương thức có tác dụng phụ (`send`, `agent`) để
  có thể retry an toàn; server giữ một bộ nhớ đệm loại trùng ngắn hạn.
- Nodes phải bao gồm `role: "node"` cùng với caps/lệnh/quyền trong `connect`.

## Ghép cặp + tin cậy cục bộ

- Tất cả client WS (toán tử + nodes) đều bao gồm **danh tính thiết bị** trong `connect`.
- Các ID thiết bị mới cần phê duyệt ghép cặp; Gateway phát hành một **token thiết bị**
  cho các lần kết nối tiếp theo.
- Kết nối **cục bộ** (loopback hoặc địa chỉ tailnet của chính máy chủ gateway) có thể
  được tự động phê duyệt để giữ trải nghiệm cùng host mượt mà.
- Kết nối **không cục bộ** phải ký nonce `connect.challenge` và cần
  phê duyệt rõ ràng.
- Xác thực Gateway (`gateway.auth.*`) vẫn áp dụng cho **tất cả** các kết nối, cục bộ hay
  từ xa.

Chi tiết: [Giao thức Gateway](/gateway/protocol), [Ghép cặp](/channels/pairing),
[Bảo mật](/gateway/security).

## Kiểu hóa giao thức và codegen

- Schema TypeBox định nghĩa giao thức.
- JSON Schema được tạo từ các schema đó.
- Model Swift được tạo từ JSON Schema.

## Truy cập từ xa

- Ưu tiên: Tailscale hoặc VPN.
- Thay thế: đường hầm SSH

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Cùng một quy trình bắt tay + token xác thực áp dụng qua đường hầm.
- Có thể bật TLS + tùy chọn pinning cho WS trong các thiết lập từ xa.

## Ảnh chụp vận hành

- Khởi động: `openclaw gateway` (chạy foreground, ghi log ra stdout).
- Tình trạng: `health` qua WS (cũng được bao gồm trong `hello-ok`).
- Giám sát: launchd/systemd để tự động khởi động lại.

## Bất biến

- Chính xác một Gateway kiểm soát một phiên Baileys trên mỗi host.
- Bắt tay là bắt buộc; bất kỳ frame đầu tiên nào không phải JSON hoặc không phải connect sẽ bị đóng cứng.
- Sự kiện không được phát lại; client phải làm mới khi có khoảng trống.
