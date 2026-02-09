---
summary: "Giao thức WebSocket của Gateway: bắt tay, khung, phiên bản hóa"
read_when:
  - Triển khai hoặc cập nhật client WS của gateway
  - Gỡ lỗi sai lệch giao thức hoặc lỗi kết nối
  - Tái tạo schema/mô hình giao thức
title: "Giao thức Gateway"
---

# Giao thức Gateway (WebSocket)

Giao thức Gateway WS là **mặt phẳng điều khiển duy nhất + vận chuyển node** cho
OpenClaw. Tất cả client (CLI, web UI, ứng dụng macOS, node iOS/Android, node
không giao diện) đều kết nối qua WebSocket và khai báo **vai trò** + **phạm vi** của họ tại
thời điểm bắt tay.

## Transport

- WebSocket, khung văn bản với payload JSON.
- Khung đầu tiên **phải** là một yêu cầu `connect`.

## Handshake (kết nối)

Gateway → Client (thử thách trước khi kết nối):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Khi phát hành device token, `hello-ok` cũng bao gồm:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Ví dụ node

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

Các phương thức gây tác dụng phụ yêu cầu **idempotency keys** (xem schema).

## Vai trò + phạm vi

### Vai trò

- `operator` = client mặt phẳng điều khiển (CLI/UI/tự động hóa).
- `node` = máy chủ năng lực (camera/screen/canvas/system.run).

### Phạm vi (operator)

Các phạm vi phổ biến:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/lệnh/quyền (node)

Các node khai báo các claim về năng lực tại thời điểm kết nối:

- `caps`: các danh mục năng lực cấp cao.
- `commands`: allowlist lệnh cho invoke.
- `permissions`: các bật/tắt chi tiết (ví dụ `screen.record`, `camera.capture`).

Gateway coi đây là **claims** và thực thi allowlist phía máy chủ.

## Presence

- `system-presence` trả về các mục được khóa theo danh tính thiết bị.
- Các mục presence bao gồm `deviceId`, `roles` và `scopes` để UI có thể hiển thị một hàng duy nhất cho mỗi thiết bị
  ngay cả khi nó kết nối đồng thời với vai trò **operator** và **node**.

### Phương thức trợ giúp cho node

- Node có thể gọi `skills.bins` để lấy danh sách hiện tại các skill executable
  phục vụ kiểm tra auto-allow.

## Phê duyệt exec

- Khi một yêu cầu exec cần phê duyệt, gateway phát `exec.approval.requested`.
- Client operator giải quyết bằng cách gọi `exec.approval.resolve` (yêu cầu phạm vi `operator.approvals`).

## Phiên bản hóa

- `PROTOCOL_VERSION` nằm trong `src/gateway/protocol/schema.ts`.
- Client gửi `minProtocol` + `maxProtocol`; máy chủ từ chối nếu không khớp.
- Schema + mô hình được tạo từ các định nghĩa TypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Xác thực

- Nếu `OPENCLAW_GATEWAY_TOKEN` (hoặc `--token`) được đặt, `connect.params.auth.token`
  phải khớp nếu không socket sẽ bị đóng.
- Sau khi ghép cặp, Gateway phát hành một **token thiết bị** được giới hạn theo vai trò kết nối + phạm vi. Nó được trả về trong `hello-ok.auth.deviceToken` và nên được
  client lưu trữ cho các lần kết nối sau.
- Device token có thể được xoay vòng/thu hồi qua `device.token.rotate` và
  `device.token.revoke` (yêu cầu phạm vi `operator.pairing`).

## Danh tính thiết bị + ghép cặp

- Node nên bao gồm một danh tính thiết bị ổn định (`device.id`) được suy ra từ
  fingerprint của cặp khóa.
- Gateway phát hành token theo từng thiết bị + vai trò.
- Cần phê duyệt ghép cặp cho các ID thiết bị mới trừ khi bật auto-approval cục bộ.
- Kết nối **Local** bao gồm loopback và địa chỉ tailnet của chính máy chủ gateway
  (để các ràng buộc tailnet cùng máy chủ vẫn có thể auto-approve).
- Tất cả client WS phải bao gồm danh tính `device` trong quá trình `connect` (operator + node).
  Control UI có thể bỏ qua nó **chỉ** khi `gateway.controlUi.allowInsecureAuth` được bật
  (hoặc `gateway.controlUi.dangerouslyDisableDeviceAuth` cho trường hợp khẩn cấp).
- Các kết nối không phải local phải ký nonce `connect.challenge` do máy chủ cung cấp.

## TLS + pinning

- TLS được hỗ trợ cho các kết nối WS.
- Client có thể tùy chọn pin fingerprint chứng chỉ của gateway (xem cấu hình `gateway.tls`
  cùng với `gateway.remote.tlsFingerprint` hoặc CLI `--tls-fingerprint`).

## Phạm vi

Giao thức này cung cấp **toàn bộ API gateway** (trạng thái, kênh, mô hình, chat,
agent, phiên, node, phê duyệt, v.v.). Bề mặt chính xác được xác định bởi các schema TypeBox trong
`src/gateway/protocol/schema.ts`.
