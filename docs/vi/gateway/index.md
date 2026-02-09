---
summary: "Runbook cho dịch vụ Gateway, vòng đời và vận hành"
read_when:
  - Khi chạy hoặc gỡ lỗi tiến trình gateway
title: "Runbook Gateway"
---

# Runbook dịch vụ Gateway

Cập nhật lần cuối: 2025-12-09

## Nó là gì

- Tiến trình luôn chạy, sở hữu kết nối Baileys/Telegram duy nhất và mặt phẳng điều khiển/sự kiện.
- Replaces the legacy `gateway` command. CLI entry point: `openclaw gateway`.
- Chạy cho đến khi bị dừng; thoát với mã khác 0 khi gặp lỗi nghiêm trọng để bộ giám sát khởi động lại.

## Cách chạy (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Hot reload cấu hình theo dõi `~/.openclaw/openclaw.json` (hoặc `OPENCLAW_CONFIG_PATH`).
  - Chế độ mặc định: `gateway.reload.mode="hybrid"` (áp dụng nóng các thay đổi an toàn, khởi động lại khi критical).
  - Hot reload dùng khởi động lại trong tiến trình qua **SIGUSR1** khi cần.
  - Tắt bằng `gateway.reload.mode="off"`.
- Gắn WebSocket mặt phẳng điều khiển vào `127.0.0.1:<port>` (mặc định 18789).
- The same port also serves HTTP (control UI, hooks, A2UI). Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Starts a Canvas file server by default on `canvasHost.port` (default `18793`), serving `http://<gateway-host>:18793/__openclaw__/canvas/` from `~/.openclaw/workspace/canvas`. Disable with `canvasHost.enabled=false` or `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Ghi log ra stdout; dùng launchd/systemd để giữ tiến trình sống và xoay vòng log.
- Truyền `--verbose` để phản chiếu log gỡ lỗi (bắt tay, req/res, sự kiện) từ tệp log sang stdio khi xử lý sự cố.
- `--force` dùng `lsof` để tìm các listener trên cổng đã chọn, gửi SIGTERM, ghi log những gì đã dừng, rồi khởi động gateway (thất bại nhanh nếu thiếu `lsof`).
- Nếu chạy dưới bộ giám sát (launchd/systemd/chế độ tiến trình con của ứng dụng mac), việc dừng/khởi động lại thường gửi **SIGTERM**; các bản build cũ có thể hiển thị là `pnpm` `ELIFECYCLE` với mã thoát **143** (SIGTERM), đây là tắt bình thường, không phải crash.
- **SIGUSR1** kích hoạt khởi động lại trong tiến trình khi được ủy quyền (gateway tool/config apply/update, hoặc bật `commands.restart` để khởi động lại thủ công).
- Gateway auth is required by default: set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password`. Clients must send `connect.params.auth.token/password` unless using Tailscale Serve identity.
- Trình hướng dẫn hiện tạo token theo mặc định, ngay cả trên loopback.
- Thứ tự ưu tiên cổng: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > mặc định `18789`.

## Truy cập từ xa

- Ưu tiên Tailscale/VPN; nếu không thì dùng đường hầm SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Client sau đó kết nối tới `ws://127.0.0.1:18789` qua đường hầm.

- Nếu đã cấu hình token, client phải kèm nó trong `connect.params.auth.token` ngay cả khi qua đường hầm.

## Nhiều gateway (cùng máy chủ)

Usually unnecessary: one Gateway can serve multiple messaging channels and agents. Use multiple Gateways only for redundancy or strict isolation (ex: rescue bot).

Supported if you isolate state + config and use unique ports. Full guide: [Multiple gateways](/gateway/multiple-gateways).

Tên dịch vụ nhận biết theo profile:

- macOS: `bot.molt.<profile>` (legacy `com.openclaw.*` may still exist)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Siêu dữ liệu cài đặt được nhúng trong cấu hình dịch vụ:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot Pattern: keep a second Gateway isolated with its own profile, state dir, workspace, and base port spacing. Full guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Profile dev (`--dev`)

Đường nhanh: chạy một instance dev cô lập hoàn toàn (config/state/workspace) mà không chạm vào thiết lập chính.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Mặc định (có thể ghi đè qua env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- cổng dịch vụ điều khiển trình duyệt = `19003` (suy ra: `gateway.port+2`, chỉ loopback)
- `canvasHost.port=19005` (suy ra: `gateway.port+4`)
- `agents.defaults.workspace` mặc định thành `~/.openclaw/workspace-dev` khi bạn chạy `setup`/`onboard` dưới `--dev`.

Các cổng suy ra (quy tắc kinh nghiệm):

- Cổng cơ sở = `gateway.port` (hoặc `OPENCLAW_GATEWAY_PORT` / `--port`)
- cổng dịch vụ điều khiển trình duyệt = cơ sở + 2 (chỉ loopback)
- `canvasHost.port = base + 4` (hoặc `OPENCLAW_CANVAS_HOST_PORT` / ghi đè cấu hình)
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108` (được lưu theo từng hồ sơ).

Danh sách kiểm tra cho mỗi instance:

- `gateway.port` duy nhất
- `OPENCLAW_CONFIG_PATH` duy nhất
- `OPENCLAW_STATE_DIR` duy nhất
- `agents.defaults.workspace` duy nhất
- số WhatsApp riêng (nếu dùng WA)

Cài đặt dịch vụ theo profile:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Ví dụ:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Giao thức (góc nhìn vận hành)

- Tài liệu đầy đủ: [Gateway protocol](/gateway/protocol) và [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Mandatory first frame from client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway phản hồi `res {type:"res", id, ok:true, payload:hello-ok }` (hoặc `ok:false` kèm lỗi, rồi đóng).
- Sau bắt tay:
  - Yêu cầu: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Sự kiện: `{type:"event", event, payload, seq?, stateVersion?}`
- Structured presence entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (đối với client WS, `instanceId` lấy từ `connect.client.instanceId`).
- Phản hồi `agent` theo hai giai đoạn: trước tiên ack `res` `{runId,status:"accepted"}`, sau đó là `res` `{runId,status:"ok"|"error",summary}` cuối cùng khi chạy xong; đầu ra dạng stream đến dưới dạng `event:"agent"`.

## Phương thức (tập ban đầu)

- `health` — ảnh chụp sức khỏe đầy đủ (cùng dạng với `openclaw health --json`).
- `status` — tóm tắt ngắn.
- `system-presence` — danh sách hiện diện hiện tại.
- `system-event` — đăng một ghi chú hiện diện/hệ thống (có cấu trúc).
- `send` — gửi tin nhắn qua (các) kênh đang hoạt động.
- `agent` — chạy một lượt tác tử (stream sự kiện trả về trên cùng kết nối).
- `node.list` — liệt kê các nút đã ghép cặp + đang kết nối (bao gồm `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, và `commands` được quảng bá).
- `node.describe` — mô tả một nút (khả năng + các lệnh `node.invoke` được hỗ trợ; hoạt động cho nút đã ghép cặp và nút chưa ghép nhưng đang kết nối).
- `node.invoke` — gọi một lệnh trên nút (ví dụ: `canvas.*`, `camera.*`).
- `node.pair.*` — vòng đời ghép cặp (`request`, `list`, `approve`, `reject`, `verify`).

Xem thêm: [Presence](/concepts/presence) để biết cách tạo/khử trùng lặp hiện diện và vì sao `client.instanceId` ổn định lại quan trọng.

## Sự kiện

- `agent` — các sự kiện công cụ/đầu ra được stream từ lượt chạy tác tử (gắn thẻ seq).
- `presence` — cập nhật hiện diện (delta kèm stateVersion) được đẩy tới tất cả client đang kết nối.
- `tick` — keepalive/no-op định kỳ để xác nhận còn sống.
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Client nên kết nối lại.

## Tích hợp WebChat

- WebChat là UI SwiftUI gốc, nói chuyện trực tiếp với Gateway WebSocket để lấy lịch sử, gửi, hủy và nhận sự kiện.
- Dùng từ xa qua cùng đường hầm SSH/Tailscale; nếu cấu hình token gateway, client sẽ kèm nó trong `connect`.
- Ứng dụng macOS kết nối qua một WS duy nhất (kết nối dùng chung); nó hydrate hiện diện từ snapshot ban đầu và lắng nghe sự kiện `presence` để cập nhật UI.

## Kiểu dữ liệu và xác thực

- Máy chủ xác thực mọi khung vào bằng AJV theo JSON Schema phát sinh từ định nghĩa giao thức.
- Client (TS/Swift) dùng các kiểu sinh tự động (TS trực tiếp; Swift qua generator của repo).
- Định nghĩa giao thức là nguồn chân lý; tạo lại schema/mô hình bằng:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Snapshot kết nối

- `hello-ok` bao gồm một `snapshot` với `presence`, `health`, `stateVersion` và `uptimeMs` cùng `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` để client có thể render ngay mà không cần yêu cầu thêm.
- `health`/`system-presence` vẫn khả dụng để làm mới thủ công, nhưng không bắt buộc lúc kết nối.

## Mã lỗi (dạng res.error)

- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
- Mã chuẩn:
  - `NOT_LINKED` — WhatsApp chưa xác thực.
  - `AGENT_TIMEOUT` — tác tử không phản hồi trong thời hạn đã cấu hình.
  - `INVALID_REQUEST` — xác thực schema/tham số thất bại.
  - `UNAVAILABLE` — Gateway đang tắt hoặc phụ thuộc không khả dụng.

## Hành vi keepalive

- Sự kiện `tick` (hoặc WS ping/pong) được phát định kỳ để client biết Gateway còn sống ngay cả khi không có lưu lượng.
- Acknowledgement cho gửi/chạy tác tử vẫn là phản hồi riêng; không dùng tick cho việc gửi.

## Phát lại / khoảng trống

- Sự kiện không được phát lại. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. Client WebChat và macOS hiện tự động làm mới khi có khoảng trống.

## Giám sát (ví dụ macOS)

- Dùng launchd để giữ dịch vụ sống:
  - Program: đường dẫn tới `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: đường dẫn tệp hoặc `syslog`
- Khi lỗi, launchd khởi động lại; cấu hình sai nghiêm trọng nên tiếp tục thoát để người vận hành nhận ra.
- LaunchAgent là theo người dùng và yêu cầu phiên đăng nhập; với thiết lập headless dùng LaunchDaemon tùy chỉnh (không kèm theo).
  - `openclaw gateway install` ghi vào `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (hoặc `bot.molt.<profile>`.plist`; các nhãn cũ `com.openclaw.\*\` sẽ được dọn dẹp).
  - `openclaw doctor` kiểm tra cấu hình LaunchAgent và có thể cập nhật về mặc định hiện hành.

## Quản lý dịch vụ Gateway (CLI)

Dùng Gateway CLI để cài đặt/khởi động/dừng/khởi động lại/trạng thái:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Ghi chú:

- `gateway status` thăm dò RPC của Gateway theo mặc định bằng cổng/cấu hình đã resolve của dịch vụ (ghi đè bằng `--url`).
- `gateway status --deep` thêm quét cấp hệ thống (LaunchDaemons/system units).
- `gateway status --no-probe` bỏ qua thăm dò RPC (hữu ích khi mạng bị down).
- `gateway status --json` ổn định cho script.
- `gateway status` báo cáo **thời gian chạy của bộ giám sát** (launchd/systemd đang chạy) tách biệt với **khả năng truy cập RPC** (kết nối WS + RPC trạng thái).
- `gateway status` in đường dẫn cấu hình + mục tiêu thăm dò để tránh nhầm “localhost vs bind LAN” và lệch profile.
- `gateway status` bao gồm dòng lỗi gateway gần nhất khi dịch vụ có vẻ đang chạy nhưng cổng bị đóng.
- `logs` tail log tệp Gateway qua RPC (không cần `tail`/`grep` thủ công).
- Nếu phát hiện các dịch vụ giống gateway khác, CLI sẽ cảnh báo trừ khi chúng là dịch vụ hồ sơ OpenClaw.
  Chúng tôi vẫn khuyến nghị **một gateway cho mỗi máy** cho hầu hết các thiết lập; sử dụng hồ sơ/cổng tách biệt để dự phòng hoặc cho bot cứu hộ. Xem [Multiple gateways](/gateway/multiple-gateways).
  - Dọn dẹp: `openclaw gateway uninstall` (dịch vụ hiện tại) và `openclaw doctor` (di trú bản cũ).
- `gateway install` là no-op khi đã cài; dùng `openclaw gateway install --force` để cài lại (thay đổi profile/env/đường dẫn).

Ứng dụng mac đóng gói:

- OpenClaw.app có thể đóng gói một gateway relay dựa trên Node và cài đặt LaunchAgent theo người dùng với nhãn
  `bot.molt.gateway` (hoặc `bot.molt.<profile>`; các nhãn cũ `com.openclaw.*` vẫn được unload sạch sẽ).
- Để dừng sạch, dùng `openclaw gateway stop` (hoặc `launchctl bootout gui/$UID/bot.molt.gateway`).
- Để khởi động lại, dùng `openclaw gateway restart` (hoặc `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` chỉ hoạt động nếu LaunchAgent đã được cài; nếu không hãy dùng `openclaw gateway install` trước.
  - Thay nhãn bằng \`bot.molt.<profile>\`\` khi chạy một hồ sơ được đặt tên.

## Giám sát (systemd user unit)

OpenClaw cài đặt **dịch vụ systemd theo người dùng** theo mặc định trên Linux/WSL2. Chúng tôi
khuyến nghị dịch vụ người dùng cho máy đơn người dùng (môi trường đơn giản hơn, cấu hình theo người dùng).
Sử dụng **dịch vụ hệ thống** cho máy chủ nhiều người dùng hoặc luôn bật (không cần lingering, giám sát dùng chung).

`openclaw gateway install` ghi user unit. `openclaw doctor` kiểm tra
the unit và có thể cập nhật nó để khớp với các mặc định khuyến nghị hiện tại.

Tạo `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Bật lingering (bắt buộc để dịch vụ người dùng tồn tại qua đăng xuất/nhàn rỗi):

```
sudo loginctl enable-linger youruser
```

Onboarding chạy lệnh này trên Linux/WSL2 (có thể yêu cầu sudo; ghi vào `/var/lib/systemd/linger`).
Sau đó kích hoạt dịch vụ:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Thay thế (dịch vụ hệ thống)** - đối với máy chủ luôn bật hoặc nhiều người dùng, bạn có thể
cài đặt một đơn vị **systemd hệ thống** thay vì đơn vị người dùng (không cần lingering).
Tạo `/etc/systemd/system/openclaw-gateway[-<profile>].service` (sao chép đơn vị ở trên,
chuyển `WantedBy=multi-user.target`, đặt `User=` + `WorkingDirectory=`), sau đó:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Cài đặt trên Windows nên dùng **WSL2** và làm theo phần systemd Linux ở trên.

## Kiểm tra vận hành

- Sống: mở WS và gửi `req:connect` → mong đợi `res` với `payload.type="hello-ok"` (kèm snapshot).
- Sẵn sàng: gọi `health` → mong đợi `ok: true` và một kênh được liên kết trong `linkChannel` (khi áp dụng).
- Gỡ lỗi: đăng ký sự kiện `tick` và `presence`; đảm bảo `status` hiển thị tuổi liên kết/xác thực; các mục hiện diện hiển thị máy chủ Gateway và client đang kết nối.

## Bảo đảm an toàn

- Mặc định giả định một Gateway trên mỗi máy; nếu chạy nhiều profile, hãy cô lập cổng/trạng thái và nhắm đúng instance.
- Không có dự phòng sang kết nối Baileys trực tiếp; nếu Gateway down, việc gửi thất bại nhanh.
- Khung đầu tiên không phải connect hoặc JSON sai định dạng sẽ bị từ chối và đóng socket.
- Tắt êm: phát sự kiện `shutdown` trước khi đóng; client phải xử lý đóng + kết nối lại.

## Trợ giúp CLI

- `openclaw gateway health|status` — yêu cầu health/trạng thái qua WS của Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — gửi qua Gateway (idempotent cho WhatsApp).
- `openclaw agent --message "hi" --to <num>` — chạy một lượt tác tử (mặc định đợi kết quả cuối).
- `openclaw gateway call <method> --params '{"k":"v"}'` — bộ gọi phương thức thô để gỡ lỗi.
- `openclaw gateway stop|restart` — dừng/khởi động lại dịch vụ gateway được giám sát (launchd/systemd).
- Các lệnh phụ trợ Gateway giả định gateway đang chạy trên `--url`; chúng không còn tự khởi tạo nữa.

## Hướng dẫn di trú

- Ngừng sử dụng `openclaw gateway` và cổng điều khiển TCP cũ.
- Cập nhật client để nói chuyện giao thức WS với connect bắt buộc và hiện diện có cấu trúc.
