---
summary: "CLI Gateway OpenClaw (`openclaw gateway`) — chạy, truy vấn và khám phá gateway"
read_when:
  - Chạy Gateway từ CLI (dev hoặc server)
  - Gỡ lỗi xác thực Gateway, chế độ bind và kết nối
  - Khám phá gateway qua Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway là máy chủ WebSocket của OpenClaw (kênh, node, phiên, hook).

Các lệnh con trong trang này nằm dưới `openclaw gateway …`.

Tài liệu liên quan:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Chạy Gateway

Chạy một tiến trình Gateway cục bộ:

```bash
openclaw gateway
```

Bí danh chạy foreground:

```bash
openclaw gateway run
```

Ghi chú:

- Theo mặc định, Gateway từ chối khởi động trừ khi `gateway.mode=local` được đặt trong `~/.openclaw/openclaw.json`. Dùng `--allow-unconfigured` cho các lần chạy ad-hoc/dev.
- Bind vượt ra ngoài loopback khi không có xác thực sẽ bị chặn (hàng rào an toàn).
- `SIGUSR1` kích hoạt khởi động lại trong tiến trình khi được ủy quyền (bật `commands.restart` hoặc dùng công cụ/config apply/update của gateway).
- Trình xử lý `SIGINT`/`SIGTERM` sẽ dừng tiến trình gateway, nhưng không khôi phục bất kỳ trạng thái terminal tùy chỉnh nào. Nếu bạn bọc CLI bằng TUI hoặc nhập liệu chế độ raw, hãy khôi phục terminal trước khi thoát.

### Tùy chọn

- `--port <port>`: cổng WebSocket (mặc định lấy từ config/biến môi trường; thường là `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: chế độ bind listener.
- `--auth <token|password>`: ghi đè chế độ xác thực.
- `--token <token>`: ghi đè token (đồng thời thiết lập `OPENCLAW_GATEWAY_TOKEN` cho tiến trình).
- `--password <password>`: ghi đè mật khẩu (đồng thời thiết lập `OPENCLAW_GATEWAY_PASSWORD` cho tiến trình).
- `--tailscale <off|serve|funnel>`: công bố Gateway qua Tailscale.
- `--tailscale-reset-on-exit`: đặt lại cấu hình serve/funnel của Tailscale khi tắt.
- `--allow-unconfigured`: cho phép gateway khởi động khi không có `gateway.mode=local` trong config.
- `--dev`: tạo config dev + workspace nếu thiếu (bỏ qua BOOTSTRAP.md).
- `--reset`: đặt lại config dev + thông tin xác thực + phiên + workspace (yêu cầu `--dev`).
- `--force`: kết thúc bất kỳ listener nào đang tồn tại trên cổng đã chọn trước khi khởi động.
- `--verbose`: log chi tiết.
- `--claude-cli-logs`: chỉ hiển thị log của claude-cli trong console (và bật stdout/stderr của nó).
- `--ws-log <auto|full|compact>`: kiểu log websocket (mặc định `auto`).
- `--compact`: bí danh cho `--ws-log compact`.
- `--raw-stream`: ghi các sự kiện luồng model thô ra jsonl.
- `--raw-stream-path <path>`: đường dẫn jsonl của luồng thô.

## Truy vấn Gateway đang chạy

Tất cả các lệnh truy vấn đều dùng RPC qua WebSocket.

Chế độ đầu ra:

- Mặc định: dễ đọc cho con người (có màu trong TTY).
- `--json`: JSON cho máy đọc (không styling/spinner).
- `--no-color` (hoặc `NO_COLOR=1`): tắt ANSI nhưng vẫn giữ bố cục cho người đọc.

Tùy chọn dùng chung (khi được hỗ trợ):

- `--url <url>`: URL WebSocket của Gateway.
- `--token <token>`: token Gateway.
- `--password <password>`: mật khẩu Gateway.
- `--timeout <ms>`: timeout/ngân sách (khác nhau theo từng lệnh).
- `--expect-final`: chờ phản hồi “final” (các lời gọi agent).

Lưu ý: khi bạn đặt `--url`, CLI sẽ không quay về dùng thông tin xác thực từ cấu hình hay môi trường.
Truyền `--token` hoặc `--password` một cách tường minh. Thiếu thông tin xác thực tường minh là một lỗi.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` hiển thị dịch vụ Gateway (launchd/systemd/schtasks) kèm theo một probe RPC tùy chọn.

```bash
openclaw gateway status
openclaw gateway status --json
```

Tùy chọn:

- `--url <url>`: ghi đè URL probe.
- `--token <token>`: xác thực token cho probe.
- `--password <password>`: xác thực mật khẩu cho probe.
- `--timeout <ms>`: timeout probe (mặc định `10000`).
- `--no-probe`: bỏ qua probe RPC (chỉ xem dịch vụ).
- `--deep`: quét cả các dịch vụ cấp hệ thống.

### `gateway probe`

`gateway probe` là lệnh “debug mọi thứ”. Nó luôn thăm dò:

- gateway từ xa đã cấu hình của bạn (nếu có), và
- localhost (loopback) **ngay cả khi đã cấu hình remote**.

Nếu có nhiều gateway có thể truy cập, nó sẽ in ra tất cả. Nhiều gateway được hỗ trợ khi bạn dùng hồ sơ/cổng độc lập (ví dụ: một bot cứu hộ), nhưng hầu hết cài đặt vẫn chỉ chạy một gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remote qua SSH (tương đương ứng dụng Mac)

Chế độ “Remote over SSH” của ứng dụng macOS dùng port-forward cục bộ để gateway từ xa (có thể chỉ bind loopback) trở nên truy cập được tại `ws://127.0.0.1:<port>`.

Tương đương CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Tùy chọn:

- `--ssh <target>`: `user@host` hoặc `user@host:port` (cổng mặc định là `22`).
- `--ssh-identity <path>`: file identity.
- `--ssh-auto`: chọn máy chủ gateway được phát hiện đầu tiên làm mục tiêu SSH (chỉ LAN/WAB).

Config (tùy chọn, dùng làm mặc định):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Trợ giúp RPC cấp thấp.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Quản lý dịch vụ Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Ghi chú:

- `gateway install` hỗ trợ `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Các lệnh vòng đời chấp nhận `--json` để dùng trong script.

## Khám phá gateway (Bonjour)

`gateway discover` quét các beacon Gateway (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): chọn một domain (ví dụ: `openclaw.internal.`) và thiết lập split DNS + máy chủ DNS; xem [/gateway/bonjour](/gateway/bonjour)

Chỉ các gateway bật khám phá Bonjour (mặc định) mới quảng bá beacon.

Các bản ghi khám phá Wide-Area bao gồm (TXT):

- `role` (gợi ý vai trò gateway)
- `transport` (gợi ý transport, ví dụ `gateway`)
- `gatewayPort` (cổng WebSocket, thường là `18789`)
- `sshPort` (cổng SSH; mặc định `22` nếu không có)
- `tailnetDns` (hostname MagicDNS, khi có)
- `gatewayTls` / `gatewayTlsSha256` (TLS được bật + fingerprint chứng chỉ)
- `cliPath` (gợi ý tùy chọn cho cài đặt remote)

### `gateway discover`

```bash
openclaw gateway discover
```

Tùy chọn:

- `--timeout <ms>`: timeout theo từng lệnh (browse/resolve); mặc định `2000`.
- `--json`: đầu ra cho máy đọc (đồng thời tắt styling/spinner).

Ví dụ:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
