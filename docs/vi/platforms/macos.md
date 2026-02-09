---
summary: "Ứng dụng đồng hành OpenClaw trên macOS (menu bar + gateway broker)"
read_when:
  - Triển khai các tính năng ứng dụng macOS
  - Thay đổi vòng đời gateway hoặc cầu nối node trên macOS
title: "Ứng dụng macOS"
---

# Ứng dụng đồng hành OpenClaw trên macOS (menu bar + gateway broker)

The macOS app is the **menu‑bar companion** for OpenClaw. It owns permissions,
manages/attaches to the Gateway locally (launchd or manual), and exposes macOS
capabilities to the agent as a node.

## Nó làm gì

- Hiển thị thông báo gốc và trạng thái trên thanh menu.
- Quản lý các lời nhắc TCC (Thông báo, Trợ năng, Ghi màn hình, Microphone,
  Nhận dạng giọng nói, Automation/AppleScript).
- Chạy hoặc kết nối tới Gateway (cục bộ hoặc từ xa).
- Phơi bày các công cụ chỉ có trên macOS (Canvas, Camera, Screen Recording, `system.run`).
- Khởi động dịch vụ node host cục bộ ở chế độ **remote** (launchd), và dừng nó ở chế độ **local**.
- Tùy chọn lưu trữ **PeekabooBridge** cho tự động hóa UI.
- Cài đặt CLI toàn cục (`openclaw`) qua npm/pnpm theo yêu cầu (không khuyến nghị bun cho runtime của Gateway).

## Chế độ local vs remote

- **Local** (mặc định): ứng dụng gắn vào một Gateway cục bộ đang chạy nếu có;
  nếu không, nó kích hoạt dịch vụ launchd qua `openclaw gateway install`.
- **Remote**: the app connects to a Gateway over SSH/Tailscale and never starts
  a local process.
  The app starts the local **node host service** so the remote Gateway can reach this Mac.
  The app does not spawn the Gateway as a child process.

## Điều khiển Launchd

The app manages a per‑user LaunchAgent labeled `bot.molt.gateway`
(or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` still unloads).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Replace the label with `bot.molt.<profile>` when running a named profile.

Nếu LaunchAgent chưa được cài đặt, hãy bật nó từ ứng dụng hoặc chạy
`openclaw gateway install`.

## Khả năng node (mac)

The macOS app presents itself as a node. Các lệnh thường dùng:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

Node báo cáo một bản đồ `permissions` để các agent có thể quyết định điều gì được phép.

Dịch vụ node + IPC của ứng dụng:

- Khi dịch vụ node host không giao diện đang chạy (chế độ remote), nó kết nối tới Gateway WS như một node.
- `system.run` được thực thi trong ứng dụng macOS (ngữ cảnh UI/TCC) qua một Unix socket cục bộ; các lời nhắc + đầu ra ở lại trong ứng dụng.

Sơ đồ (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Phê duyệt Exec (system.run)

`system.run` is controlled by **Exec approvals** in the macOS app (Settings → Exec approvals).
Security + ask + allowlist are stored locally on the Mac in:

```
~/.openclaw/exec-approvals.json
```

Ví dụ:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Ghi chú:

- Các mục `allowlist` là các mẫu glob cho đường dẫn nhị phân đã được resolve.
- Chọn “Always Allow” trong lời nhắc sẽ thêm lệnh đó vào allowlist.
- Các override biến môi trường `system.run` được lọc (loại bỏ `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) rồi sau đó được hợp nhất với môi trường của ứng dụng.

## Deep links

Ứng dụng đăng ký URL scheme `openclaw://` cho các hành động cục bộ.

### `openclaw://agent`

Kích hoạt một yêu cầu Gateway `agent`.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Tham số truy vấn:

- `message` (bắt buộc)
- `sessionKey` (tùy chọn)
- `thinking` (tùy chọn)
- `deliver` / `to` / `channel` (tùy chọn)
- `timeoutSeconds` (tùy chọn)
- `key` (khóa chế độ unattended, tùy chọn)

An toàn:

- Không có `key`, ứng dụng sẽ hỏi xác nhận.
- Với `key` hợp lệ, lần chạy sẽ ở chế độ unattended (dành cho tự động hóa cá nhân).

## Luồng onboarding (điển hình)

1. Cài đặt và khởi chạy **OpenClaw.app**.
2. Hoàn tất danh sách kiểm tra quyền (các lời nhắc TCC).
3. Đảm bảo chế độ **Local** đang hoạt động và Gateway đang chạy.
4. Cài đặt CLI nếu bạn muốn truy cập từ terminal.

## Quy trình build & dev (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (hoặc Xcode)
- Đóng gói ứng dụng: `scripts/package-mac-app.sh`

## Gỡ lỗi kết nối gateway (macOS CLI)

Sử dụng debug CLI để thực hiện cùng một bắt tay WebSocket của Gateway và logic
khám phá mà ứng dụng macOS sử dụng, mà không cần khởi chạy ứng dụng.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Tùy chọn kết nối:

- `--url <ws://host:port>`: ghi đè cấu hình
- `--mode <local|remote>`: resolve từ cấu hình (mặc định: config hoặc local)
- `--probe`: buộc kiểm tra sức khỏe mới
- `--timeout <ms>`: thời gian chờ yêu cầu (mặc định: `15000`)
- `--json`: đầu ra có cấu trúc để diff

Tùy chọn khám phá:

- `--include-local`: bao gồm các gateway vốn sẽ bị lọc là “local”
- `--timeout <ms>`: cửa sổ khám phá tổng thể (mặc định: `2000`)
- `--json`: đầu ra có cấu trúc để diff

Mẹo: so sánh với `openclaw gateway discover --json` để xem liệu
pipeline khám phá của ứng dụng macOS (NWBrowser + tailnet DNS‑SD fallback) có khác với
khám phá dựa trên `dns-sd` của Node CLI hay không.

## Hệ thống kết nối từ xa (đường hầm SSH)

Khi ứng dụng macOS chạy ở chế độ **Remote**, nó mở một đường hầm SSH để các thành phần UI cục bộ
có thể nói chuyện với Gateway từ xa như thể nó đang ở localhost.

### Đường hầm điều khiển (cổng WebSocket của Gateway)

- **Mục đích:** kiểm tra sức khỏe, trạng thái, Web Chat, cấu hình, và các lời gọi control‑plane khác.
- **Cổng local:** cổng Gateway (mặc định `18789`), luôn ổn định.
- **Cổng remote:** cùng cổng Gateway trên máy chủ từ xa.
- **Hành vi:** không dùng cổng local ngẫu nhiên; ứng dụng tái sử dụng một đường hầm đang khỏe
  hoặc khởi động lại nếu cần.
- **Dạng SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` với BatchMode +
  ExitOnForwardFailure + các tùy chọn keepalive.
- **IP reporting:** the SSH tunnel uses loopback, so the gateway will see the node
  IP as `127.0.0.1`. Use **Direct (ws/wss)** transport if you want the real client
  IP to appear (see [macOS remote access](/platforms/mac/remote)).

For setup steps, see [macOS remote access](/platforms/mac/remote). For protocol
details, see [Gateway protocol](/gateway/protocol).

## Tài liệu liên quan

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [Quyền macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
