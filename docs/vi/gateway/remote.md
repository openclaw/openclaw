---
summary: "Truy cập từ xa bằng đường hầm SSH (Gateway WS) và tailnet"
read_when:
  - Chạy hoặc xử lý sự cố các thiết lập gateway từ xa
title: "Truy cập từ xa"
---

# Truy cập từ xa (SSH, đường hầm, và tailnet)

Repo này hỗ trợ “truy cập từ xa qua SSH” bằng cách duy trì một Gateway duy nhất (máy chủ chính) chạy trên một máy chuyên dụng (desktop/server) và kết nối các client tới đó.

- Dành cho **operator (bạn / ứng dụng macOS)**: đường hầm SSH là phương án dự phòng phổ quát.
- Dành cho **node (iOS/Android và các thiết bị tương lai)**: kết nối tới **Gateway WebSocket** (LAN/tailnet hoặc đường hầm SSH khi cần).

## Ý tưởng cốt lõi

- Gateway WebSocket bind vào **loopback** trên cổng bạn cấu hình (mặc định 18789).
- Khi dùng từ xa, bạn chuyển tiếp cổng loopback đó qua SSH (hoặc dùng tailnet/VPN để giảm nhu cầu tạo đường hầm).

## Các thiết lập VPN/tailnet phổ biến (nơi agent chạy)

Hãy nghĩ **máy chủ Gateway** là “nơi agent sinh sống.” Nó sở hữu các phiên, hồ sơ xác thực, kênh và trạng thái.
Laptop/desktop của bạn (và các node) kết nối tới máy chủ đó.

### 1. Gateway luôn bật trong tailnet của bạn (VPS hoặc máy chủ tại nhà)

Chạy Gateway trên một máy chủ cố định và truy cập qua **Tailscale** hoặc SSH.

- **Trải nghiệm tốt nhất:** giữ `gateway.bind: "loopback"` và dùng **Tailscale Serve** cho Control UI.
- **Phương án dự phòng:** giữ loopback + đường hầm SSH từ bất kỳ máy nào cần truy cập.
- **Ví dụ:** [exe.dev](/install/exe-dev) (VM dễ dùng) hoặc [Hetzner](/install/hetzner) (VPS sản xuất).

Cách này lý tưởng khi laptop của bạn thường xuyên sleep nhưng bạn muốn agent luôn bật.

### 2. Desktop tại nhà chạy Gateway, laptop điều khiển từ xa

Máy tính xách tay **không** chạy agent. Nó kết nối từ xa:

- Dùng chế độ **Remote over SSH** của ứng dụng macOS (Settings → General → “OpenClaw runs”).
- Ứng dụng tự mở và quản lý đường hầm, nên WebChat + kiểm tra tình trạng hoạt động “chạy ngay”.

Runbook: [macOS remote access](/platforms/mac/remote).

### 3. Laptop chạy Gateway, truy cập từ xa từ các máy khác

Giữ Gateway chạy cục bộ nhưng phơi bày an toàn:

- Tạo đường hầm SSH tới laptop từ các máy khác, hoặc
- Dùng Tailscale Serve cho Control UI và giữ Gateway chỉ bind loopback.

Hướng dẫn: [Tailscale](/gateway/tailscale) và [Web overview](/web).

## Luồng lệnh (chạy ở đâu)

Một dịch vụ gateway sở hữu trạng thái + kênh. Các node là thiết bị ngoại vi.

Ví dụ luồng (Telegram → node):

- Tin nhắn Telegram đến **Gateway**.
- Gateway chạy **agent** và quyết định có gọi công cụ của node hay không.
- Gateway gọi **node** qua Gateway WebSocket (RPC `node.*`).
- Node trả kết quả; Gateway phản hồi lại Telegram.

Ghi chú:

- **Node không chạy dịch vụ gateway.** Mỗi host chỉ nên chạy một gateway trừ khi bạn cố ý chạy các hồ sơ cô lập (xem [Multiple gateways](/gateway/multiple-gateways)).
- Chế độ “node mode” của ứng dụng macOS chỉ là một client node qua Gateway WebSocket.

## Đường hầm SSH (CLI + công cụ)

Tạo một đường hầm cục bộ tới Gateway WS từ xa:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Khi đường hầm đã mở:

- `openclaw health` và `openclaw status --deep` giờ truy cập gateway từ xa qua `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` cũng có thể nhắm tới URL đã chuyển tiếp qua `--url` khi cần.

Lưu ý: thay `18789` bằng `gateway.port` đã cấu hình (hoặc `--port`/`OPENCLAW_GATEWAY_PORT`).
Lưu ý: khi bạn truyền `--url`, CLI sẽ không fallback sang thông tin xác thực từ cấu hình hoặc môi trường.
9. Bao gồm `--token` hoặc `--password` một cách tường minh. Thiếu thông tin xác thực tường minh là một lỗi.

## Mặc định từ xa của CLI

Bạn có thể lưu một mục tiêu từ xa để các lệnh CLI dùng mặc định:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Khi gateway chỉ bind loopback, giữ URL ở `ws://127.0.0.1:18789` và mở đường hầm SSH trước.

## Chat UI qua SSH

WebChat không còn sử dụng một cổng HTTP riêng. UI chat SwiftUI kết nối trực tiếp tới Gateway WebSocket.

- Chuyển tiếp `18789` qua SSH (xem trên), rồi kết nối client tới `ws://127.0.0.1:18789`.
- Trên macOS, ưu tiên chế độ “Remote over SSH” của ứng dụng, chế độ này tự quản lý đường hầm.

## Ứng dụng macOS “Remote over SSH”

Ứng dụng menu bar trên macOS có thể điều khiển toàn bộ thiết lập này từ đầu đến cuối (kiểm tra trạng thái từ xa, WebChat và chuyển tiếp Voice Wake).

Runbook: [macOS remote access](/platforms/mac/remote).

## Quy tắc bảo mật (từ xa/VPN)

Phiên bản ngắn gọn: **giữ Gateway chỉ bind loopback** trừ khi bạn chắc chắn cần bind ra ngoài.

- **Loopback + SSH/Tailscale Serve** là mặc định an toàn nhất (không phơi bày công khai).
- **Bind không phải loopback** (`lan`/`tailnet`/`custom`, hoặc `auto` khi loopback không khả dụng) phải dùng token/mật khẩu xác thực.
- `gateway.remote.token` **chỉ** dành cho các lệnh CLI từ xa — **không** bật xác thực cục bộ.
- `gateway.remote.tlsFingerprint` ghim chứng chỉ TLS từ xa khi dùng `wss://`.
- **Tailscale Serve** có thể xác thực qua header danh tính khi `gateway.auth.allowTailscale: true`.
  Đặt thành `false` nếu bạn muốn dùng token/mật khẩu thay thế.
- Hãy coi điều khiển qua trình duyệt như quyền operator: chỉ trong tailnet + ghép cặp node có chủ đích.

Phân tích chi tiết: [Security](/gateway/security).
