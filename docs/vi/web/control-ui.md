---
summary: "Giao diện điều khiển dựa trên trình duyệt cho Gateway (chat, node, cấu hình)"
read_when:
  - Bạn muốn vận hành Gateway từ trình duyệt
  - Bạn muốn truy cập Tailnet mà không cần đường hầm SSH
title: "Control UI"
---

# Control UI (trình duyệt)

Control UI là một ứng dụng một trang nhỏ **Vite + Lit** được Gateway phục vụ:

- mặc định: `http://<host>:18789/`
- tiền tố tùy chọn: đặt `gateway.controlUi.basePath` (ví dụ: `/openclaw`)

Nó giao tiếp **trực tiếp với Gateway WebSocket** trên cùng một cổng.

## Mở nhanh (local)

Nếu Gateway đang chạy trên cùng một máy, hãy mở:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (hoặc [http://localhost:18789/](http://localhost:18789/))

Nếu trang không tải được, hãy khởi động Gateway trước: `openclaw gateway`.

Xác thực được cung cấp trong quá trình bắt tay WebSocket thông qua:

- `connect.params.auth.token`
- 48. `connect.params.auth.password`
      Bảng cài đặt dashboard cho phép bạn lưu một token; mật khẩu không được lưu trữ.
      Trình hướng dẫn onboarding tạo token gateway theo mặc định, vì vậy hãy dán nó vào đây khi kết nối lần đầu.

## Ghép cặp thiết bị (kết nối lần đầu)

Khi bạn kết nối tới Control UI từ một trình duyệt hoặc thiết bị mới, Gateway yêu cầu **phê duyệt ghép cặp một lần** — ngay cả khi bạn đang ở cùng Tailnet với `gateway.auth.allowTailscale: true`. 49. Đây là một biện pháp bảo mật để ngăn chặn
truy cập trái phép.

**Những gì bạn sẽ thấy:** "disconnected (1008): pairing required"

**Để phê duyệt thiết bị:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Sau khi được phê duyệt, thiết bị sẽ được ghi nhớ và sẽ không cần phê duyệt lại trừ khi bạn thu hồi bằng `openclaw devices revoke --device <id> --role <role>`. Xem
[Devices CLI](/cli/devices) để xoay vòng và thu hồi token.

**Ghi chú:**

- Kết nối local (`127.0.0.1`) được tự động phê duyệt.
- Kết nối từ xa (LAN, Tailnet, v.v.) 50. yêu cầu phê duyệt rõ ràng.
- Mỗi hồ sơ trình duyệt tạo một ID thiết bị duy nhất, vì vậy việc đổi trình duyệt hoặc
  xóa dữ liệu trình duyệt sẽ yêu cầu ghép cặp lại.

## Những gì có thể làm (hiện tại)

- Chat với mô hình qua Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Stream các lời gọi công cụ + thẻ đầu ra công cụ trực tiếp trong Chat (sự kiện tác tử)
- Kênh: WhatsApp/Telegram/Discord/Slack + các kênh plugin (Mattermost, v.v.) trạng thái + đăng nhập QR + cấu hình theo kênh (`channels.status`, `web.login.*`, `config.patch`)
- Instances: danh sách hiện diện + làm mới (`system-presence`)
- Sessions: danh sách + ghi đè thinking/verbose theo từng phiên (`sessions.list`, `sessions.patch`)
- Cron jobs: liệt kê/thêm/chạy/bật/tắt + lịch sử chạy (`cron.*`)
- Skills: trạng thái, bật/tắt, cài đặt, cập nhật khóa API (`skills.*`)
- Nodes: danh sách + caps (`node.list`)
- Phê duyệt exec: chỉnh sửa allowlist của gateway hoặc node + chính sách hỏi cho `exec host=gateway/node` (`exec.approvals.*`)
- Config: xem/chỉnh sửa `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: áp dụng + khởi động lại với xác thực (`config.apply`) và đánh thức phiên hoạt động gần nhất
- Ghi cấu hình bao gồm cơ chế bảo vệ base-hash để tránh ghi đè các chỉnh sửa đồng thời
- Schema cấu hình + render biểu mẫu (`config.schema`, bao gồm schema plugin + kênh); trình chỉnh sửa JSON thô vẫn khả dụng
- Debug: snapshot trạng thái/sức khỏe/mô hình + nhật ký sự kiện + gọi RPC thủ công (`status`, `health`, `models.list`)
- Logs: theo dõi trực tiếp log file gateway với lọc/xuất (`logs.tail`)
- Update: chạy cập nhật gói/git + khởi động lại (`update.run`) kèm báo cáo khởi động lại

Ghi chú về bảng Cron jobs:

- Đối với các tác vụ cô lập, phương thức gửi mặc định là thông báo tóm tắt. Bạn có thể chuyển sang none nếu muốn chạy chỉ nội bộ.
- Trường kênh/đích sẽ xuất hiện khi chọn announce.

## Hành vi chat

- `chat.send` là **không chặn**: nó xác nhận ngay bằng `{ runId, status: "started" }` và phản hồi được stream qua các sự kiện `chat`.
- Gửi lại với cùng `idempotencyKey` sẽ trả về `{ status: "in_flight" }` khi đang chạy, và `{ status: "ok" }` sau khi hoàn tất.
- `chat.inject` thêm một ghi chú trợ lý vào bản ghi phiên và phát sự kiện `chat` để cập nhật UI (chỉ UI, không chạy tác tử, không gửi kênh).
- Dừng:
  - Nhấp **Stop** (gọi `chat.abort`)
  - Gõ `/stop` (hoặc `stop|esc|abort|wait|exit|interrupt`) để hủy ngoài luồng
  - `chat.abort` hỗ trợ `{ sessionKey }` (không cần `runId`) để hủy tất cả các lần chạy đang hoạt động cho phiên đó

## Truy cập Tailnet (khuyến nghị)

### Tailscale Serve tích hợp (ưu tiên)

Giữ Gateway trên loopback và để Tailscale Serve proxy nó bằng HTTPS:

```bash
openclaw gateway --tailscale serve
```

Mở:

- `https://<magicdns>/` (hoặc `gateway.controlUi.basePath` đã cấu hình của bạn)

Theo mặc định, các yêu cầu Serve có thể xác thực qua các header danh tính Tailscale (`tailscale-user-login`) khi `gateway.auth.allowTailscale` là `true`. OpenClaw
xác minh danh tính bằng cách phân giải địa chỉ `x-forwarded-for` bằng
`tailscale whois` và đối chiếu nó với header, và chỉ chấp nhận các yêu cầu này khi
request đi vào loopback với các header `x-forwarded-*` của Tailscale. Đặt
`gateway.auth.allowTailscale: false` (hoặc ép `gateway.auth.mode: "password"`)
nếu bạn muốn yêu cầu token/mật khẩu ngay cả đối với lưu lượng Serve.

### Bind vào tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Sau đó mở:

- `http://<tailscale-ip>:18789/` (hoặc `gateway.controlUi.basePath` đã cấu hình của bạn)

Dán token vào cài đặt UI (được gửi dưới dạng `connect.params.auth.token`).

## HTTP không an toàn

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),
the browser runs in a **non-secure context** and blocks WebCrypto. By default,
OpenClaw **blocks** Control UI connections without device identity.

**Cách khắc phục khuyến nghị:** dùng HTTPS (Tailscale Serve) hoặc mở UI cục bộ:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (trên máy chủ gateway)

**Ví dụ hạ cấp (chỉ token qua HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

26. Điều này vô hiệu hóa định danh thiết bị + ghép cặp cho Control UI (kể cả trên HTTPS). Use
    only if you trust the network.

Xem [Tailscale](/gateway/tailscale) để được hướng dẫn thiết lập HTTPS.

## Build UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Base tuyệt đối tùy chọn (khi bạn muốn URL tài nguyên cố định):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Để phát triển local (máy chủ dev riêng):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Sau đó trỏ UI tới URL Gateway WS của bạn (ví dụ: `ws://127.0.0.1:18789`).

## Gỡ lỗi/kiểm thử: dev server + Gateway từ xa

27. Control UI là các tệp tĩnh; đích WebSocket có thể cấu hình và có thể
    khác với nguồn gốc HTTP. Điều này hữu ích khi bạn muốn chạy máy chủ dev Vite
    cục bộ nhưng Gateway chạy ở nơi khác.

1. Khởi động UI dev server: `pnpm ui:dev`
2. Mở một URL như:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Xác thực một lần tùy chọn (nếu cần):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Ghi chú:

- `gatewayUrl` được lưu trong localStorage sau khi tải và bị xóa khỏi URL.
- `token` được lưu trong localStorage; `password` chỉ được giữ trong bộ nhớ.
- 28. Khi `gatewayUrl` được đặt, UI sẽ không quay về sử dụng thông tin xác thực từ cấu hình hoặc môi trường.
      Provide `token` (or `password`) explicitly. 29. Thiếu thông tin xác thực rõ ràng là một lỗi.
- Dùng `wss://` khi Gateway nằm sau TLS (Tailscale Serve, proxy HTTPS, v.v.).
- `gatewayUrl` chỉ được chấp nhận trong cửa sổ cấp cao nhất (không nhúng) để ngăn clickjacking.
- Với các thiết lập dev khác origin (ví dụ: `pnpm ui:dev` tới một Gateway từ xa), hãy thêm origin của UI
  vào `gateway.controlUi.allowedOrigins`.

Ví dụ:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Chi tiết thiết lập truy cập từ xa: [Remote access](/gateway/remote).
