---
summary: "Giao thức Bridge (các node kế thừa): TCP JSONL, ghép cặp, RPC theo phạm vi"
read_when:
  - Xây dựng hoặc gỡ lỗi client node (chế độ node iOS/Android/macOS)
  - Điều tra lỗi ghép cặp hoặc xác thực bridge
  - Kiểm toán bề mặt node được gateway phơi bày
title: "Giao thức Bridge"
---

# Giao thức Bridge (vận chuyển node kế thừa)

The Bridge protocol is a **legacy** node transport (TCP JSONL). New node clients
should use the unified Gateway WebSocket protocol instead.

Nếu bạn đang xây dựng một operator hoặc client node, hãy dùng
[Giao thức Gateway](/gateway/protocol).

**Note:** Current OpenClaw builds no longer ship the TCP bridge listener; this document is kept for historical reference.
Legacy `bridge.*` config keys are no longer part of the config schema.

## Vì sao chúng tôi có cả hai

- **Ranh giới bảo mật**: bridge chỉ phơi bày một danh sách cho phép nhỏ thay vì
  toàn bộ bề mặt API của gateway.
- **Ghép cặp + danh tính node**: việc cho phép node được sở hữu bởi gateway và gắn với token theo từng node.
- **UX khám phá**: node có thể khám phá gateway qua Bonjour trên LAN, hoặc kết nối
  trực tiếp qua tailnet.
- **WS loopback**: mặt phẳng điều khiển WS đầy đủ được giữ cục bộ trừ khi được
  chuyển tiếp qua đường hầm SSH.

## Vận chuyển

- TCP, mỗi dòng là một đối tượng JSON (JSONL).
- TLS tùy chọn (khi `bridge.tls.enabled` là true).
- Cổng listener mặc định kế thừa là `18790` (các bản dựng hiện tại không khởi động TCP bridge).

Khi bật TLS, các bản ghi TXT cho discovery bao gồm `bridgeTls=1` cộng với
`bridgeTlsSha256` để node có thể ghim chứng chỉ.

## Bắt tay + ghép cặp

1. Client gửi `hello` với metadata của node + token (nếu đã ghép cặp).
2. Nếu chưa ghép cặp, gateway trả lời `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Client gửi `pair-request`.
4. Gateway chờ phê duyệt, sau đó gửi `pair-ok` và `hello-ok`.

`hello-ok` trả về `serverName` và có thể bao gồm `canvasHostUrl`.

## Khung (Frames)

Client → Gateway:

- `req` / `res`: RPC của Gateway theo phạm vi (chat, sessions, config, health, voicewake, skills.bins)
- `event`: tín hiệu node (bản chép lời giọng nói, yêu cầu agent, đăng ký chat, vòng đời exec)

Gateway → Client:

- `invoke` / `invoke-res`: lệnh node (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: cập nhật chat cho các phiên đã đăng ký
- `ping` / `pong`: keepalive

Việc thực thi danh sách cho phép kế thừa nằm trong `src/gateway/server-bridge.ts` (đã bị loại bỏ).

## Sự kiện vòng đời Exec

Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.
These are mapped to system events in the gateway. (Các node legacy vẫn có thể phát ra `exec.started`.)

Các trường payload (tất cả đều tùy chọn trừ khi có ghi chú):

- `sessionKey` (bắt buộc): phiên agent để nhận sự kiện hệ thống.
- `runId`: id exec duy nhất để nhóm.
- `command`: chuỗi lệnh thô hoặc đã định dạng.
- `exitCode`, `timedOut`, `success`, `output`: chi tiết hoàn tất (chỉ khi finished).
- `reason`: lý do từ chối (chỉ khi denied).

## Sử dụng tailnet

- Gắn bridge vào IP tailnet: `bridge.bind: "tailnet"` trong
  `~/.openclaw/openclaw.json`.
- Client kết nối qua tên MagicDNS hoặc IP tailnet.
- Bonjour **không** hoạt động xuyên mạng; hãy dùng host/cổng thủ công hoặc DNS‑SD diện rộng
  khi cần.

## Phiên bản hóa

Bridge is currently **implicit v1** (no min/max negotiation). Backward‑compat
is expected; add a bridge protocol version field before any breaking changes.
