---
summary: "Nodes: ghép cặp, khả năng, quyền hạn và các trợ giúp CLI cho canvas/camera/màn hình/hệ thống"
read_when:
  - Ghép cặp các node iOS/Android với một gateway
  - Sử dụng canvas/camera của node cho ngữ cảnh tác tử
  - Thêm lệnh node mới hoặc trợ giúp CLI
title: "Nodes"
---

# Nodes

Một **node** là một thiết bị đồng hành (macOS/iOS/Android/headless) kết nối tới **WebSocket** của Gateway (cùng cổng với operators) với `role: "node"` và cung cấp bề mặt lệnh (ví dụ: `canvas.*`, `camera.*`, `system.*`) thông qua `node.invoke`. Chi tiết giao thức: [Gateway protocol](/gateway/protocol).

Vận chuyển cũ: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; đã lỗi thời/loại bỏ cho các node hiện tại).

macOS cũng có thể chạy ở **node mode**: ứng dụng menubar kết nối tới máy chủ WS của Gateway và mở các lệnh canvas/camera cục bộ của nó như một node (vì vậy `openclaw nodes …` hoạt động với máy Mac này).

Ghi chú:

- Nodes là **thiết bị ngoại vi**, không phải gateway. Chúng không chạy dịch vụ gateway.
- Tin nhắn Telegram/WhatsApp/v.v. đi vào **gateway**, không vào node.
- Runbook xử lý sự cố: [/nodes/troubleshooting](/nodes/troubleshooting)

## Ghép cặp + trạng thái

**WS nodes sử dụng ghép cặp thiết bị.** Nodes trình bày danh tính thiết bị trong quá trình `connect`; Gateway tạo yêu cầu ghép cặp thiết bị cho `role: node`. Phê duyệt qua CLI (hoặc UI) của thiết bị.

CLI nhanh:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Ghi chú:

- `nodes status` đánh dấu một node là **đã ghép cặp** khi vai trò ghép cặp thiết bị của nó bao gồm `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) là một kho ghép cặp node riêng do gateway sở hữu; nó **không** chặn bắt tay WS `connect`.

## Máy chủ node từ xa (system.run)

Sử dụng **node host** khi Gateway của bạn chạy trên một máy và bạn muốn các lệnh được thực thi trên máy khác. Mô hình vẫn giao tiếp với **gateway**; gateway chuyển tiếp các lệnh `exec` tới **node host** khi chọn `host=node`.

### Cái gì chạy ở đâu

- **Gateway host**: nhận tin nhắn, chạy mô hình, định tuyến các lời gọi công cụ.
- **Node host**: thực thi `system.run`/`system.which` trên máy node.
- **Phê duyệt**: được áp dụng trên node host thông qua `~/.openclaw/exec-approvals.json`.

### Khởi động node host (foreground)

Trên máy node:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gateway từ xa qua đường hầm SSH (ràng buộc loopback)

Nếu Gateway bind vào loopback (`gateway.bind=loopback`, mặc định ở chế độ local), các node host từ xa không thể kết nối trực tiếp. Tạo một đường hầm SSH và trỏ node host tới đầu cục bộ của đường hầm.

Ví dụ (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Ghi chú:

- Token là `gateway.auth.token` từ cấu hình gateway (`~/.openclaw/openclaw.json` trên gateway host).
- `openclaw node run` đọc `OPENCLAW_GATEWAY_TOKEN` để xác thực.

### Khởi động node host (dịch vụ)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Ghép cặp + đặt tên

Trên gateway host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Tùy chọn đặt tên:

- `--display-name` trên `openclaw node run` / `openclaw node install` (lưu trong `~/.openclaw/node.json` trên node).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (ghi đè từ gateway).

### Cho phép danh sách lệnh

Phê duyệt exec là **theo từng node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Các phê duyệt nằm trên node host tại `~/.openclaw/exec-approvals.json`.

### Trỏ exec tới node

Cấu hình mặc định (cấu hình gateway):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Hoặc theo từng phiên:

```
/exec host=node security=allowlist node=<id-or-name>
```

Khi đã đặt, mọi lời gọi `exec` với `host=node` sẽ chạy trên node host (tuân theo
allowlist/phê duyệt của node).

Liên quan:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Gọi lệnh

Mức thấp (RPC thô):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Có các trợ giúp mức cao hơn cho các luồng phổ biến kiểu “đưa cho tác tử một tệp đính kèm MEDIA”.

## Ảnh chụp màn hình (canvas snapshots)

Nếu node đang hiển thị Canvas (WebView), `canvas.snapshot` trả về `{ format, base64 }`.

Trợ giúp CLI (ghi ra tệp tạm và in `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Điều khiển Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Ghi chú:

- `canvas present` chấp nhận URL hoặc đường dẫn tệp cục bộ (`--target`), kèm `--x/--y/--width/--height` tùy chọn để định vị.
- `canvas eval` chấp nhận JS nội tuyến (`--js`) hoặc một đối số vị trí.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Ghi chú:

- Chỉ hỗ trợ A2UI v0.8 JSONL (v0.9/createSurface bị từ chối).

## Ảnh + video (camera node)

Ảnh (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Đoạn video (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Ghi chú:

- Node phải ở **foreground** để `canvas.*` và `camera.*` hoạt động (gọi nền trả về `NODE_BACKGROUND_UNAVAILABLE`).
- Thời lượng clip bị giới hạn (hiện tại `<= 60s`) để tránh payload base64 quá lớn.
- Android sẽ yêu cầu quyền `CAMERA`/`RECORD_AUDIO` khi có thể; nếu bị từ chối sẽ thất bại với `*_PERMISSION_REQUIRED`.

## Ghi màn hình (nodes)

Nodes cung cấp `screen.record` (mp4). Ví dụ:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Ghi chú:

- `screen.record` yêu cầu ứng dụng node ở foreground.
- Android sẽ hiển thị lời nhắc hệ thống chụp màn hình trước khi ghi.
- Ghi màn hình bị giới hạn ở `<= 60s`.
- `--no-audio` tắt thu mic (hỗ trợ trên iOS/Android; macOS dùng âm thanh ghi hệ thống).
- Dùng `--screen <index>` để chọn màn hình khi có nhiều màn hình.

## Vị trí (nodes)

Nodes cung cấp `location.get` khi Location được bật trong cài đặt.

Trợ giúp CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Ghi chú:

- Location **tắt theo mặc định**.
- “Always” yêu cầu quyền hệ thống; lấy nền là best-effort.
- Phản hồi bao gồm lat/lon, độ chính xác (mét) và dấu thời gian.

## SMS (Android nodes)

Node Android có thể cung cấp `sms.send` khi người dùng cấp quyền **SMS** và thiết bị hỗ trợ thoại.

Gọi mức thấp:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Ghi chú:

- Lời nhắc quyền phải được chấp nhận trên thiết bị Android trước khi khả năng được quảng bá.
- Thiết bị chỉ Wi‑Fi không có thoại sẽ không quảng bá `sms.send`.

## Lệnh hệ thống (node host / mac node)

Node macOS cung cấp `system.run`, `system.notify`, và `system.execApprovals.get/set`.
Node host headless cung cấp `system.run`, `system.which`, và `system.execApprovals.get/set`.

Ví dụ:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Ghi chú:

- `system.run` trả về stdout/stderr/mã thoát trong payload.
- `system.notify` tuân theo trạng thái quyền thông báo trên ứng dụng macOS.
- `system.run` hỗ trợ `--cwd`, `--env KEY=VAL`, `--command-timeout`, và `--needs-screen-recording`.
- `system.notify` hỗ trợ `--priority <passive|active|timeSensitive>` và `--delivery <system|overlay|auto>`.
- Node macOS bỏ qua các ghi đè `PATH`; node host headless chỉ chấp nhận `PATH` khi nó thêm tiền tố PATH của node host.
- Ở chế độ node macOS, `system.run` bị kiểm soát bởi phê duyệt exec trong ứng dụng macOS (Settings → Exec approvals).
  Ask/allowlist/full hoạt động giống như node host headless; các prompt bị từ chối trả về `SYSTEM_RUN_DENIED`.
- Trên node host headless, `system.run` bị chặn bởi phê duyệt exec (`~/.openclaw/exec-approvals.json`).

## Ràng buộc exec với node

Khi có nhiều node khả dụng, bạn có thể ràng buộc exec với một node cụ thể.
Điều này đặt node mặc định cho `exec host=node` (và có thể bị ghi đè theo từng agent).

Mặc định toàn cục:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Ghi đè theo tác tử:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Bỏ đặt để cho phép bất kỳ node nào:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Bản đồ quyền

Nodes có thể bao gồm một bản đồ `permissions` trong `node.list` / `node.describe`, được khóa theo tên quyền (ví dụ: `screenRecording`, `accessibility`) với giá trị boolean (`true` = đã cấp).

## Node host headless (đa nền tảng)

OpenClaw có thể chạy một **headless node host** (không UI) kết nối tới WebSocket của Gateway và cung cấp `system.run` / `system.which`. This is useful on Linux/Windows
or for running a minimal node alongside a server.

Khởi động:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Ghi chú:

- Vẫn cần ghép cặp (Gateway sẽ hiển thị lời nhắc phê duyệt node).
- Node host lưu node id, token, tên hiển thị và thông tin kết nối gateway trong `~/.openclaw/node.json`.
- Phê duyệt exec được áp dụng cục bộ qua `~/.openclaw/exec-approvals.json`
  (xem [Exec approvals](/tools/exec-approvals)).
- Trên macOS, headless node host ưu tiên exec host của ứng dụng đồng hành khi có thể kết nối và sẽ chuyển sang thực thi cục bộ nếu ứng dụng không khả dụng. Đặt `OPENCLAW_NODE_EXEC_HOST=app` để yêu cầu ứng dụng, hoặc `OPENCLAW_NODE_EXEC_FALLBACK=0` để vô hiệu hóa fallback.
- Thêm `--tls` / `--tls-fingerprint` khi Gateway WS dùng TLS.

## Chế độ node macOS

- Ứng dụng menubar macOS kết nối tới máy chủ WS của Gateway như một node (vì vậy `openclaw nodes …` hoạt động với máy Mac này).
- Ở chế độ từ xa, ứng dụng mở một đường hầm SSH cho cổng Gateway và kết nối tới `localhost`.
