---
summary: "Khám phá Bonjour/mDNS + gỡ lỗi (beacon của Gateway, máy khách và các chế độ lỗi phổ biến)"
read_when:
  - Gỡ lỗi các sự cố khám phá Bonjour trên macOS/iOS
  - Thay đổi loại dịch vụ mDNS, bản ghi TXT hoặc UX khám phá
title: "Khám phá Bonjour"
---

# Khám phá Bonjour / mDNS

OpenClaw uses Bonjour (mDNS / DNS‑SD) as a **LAN‑only convenience** to discover
an active Gateway (WebSocket endpoint). It is best‑effort and does **not** replace SSH or
Tailnet-based connectivity.

## Bonjour phạm vi rộng (Unicast DNS‑SD) qua Tailscale

If the node and gateway are on different networks, multicast mDNS won’t cross the
boundary. You can keep the same discovery UX by switching to **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

Các bước tổng quát:

1. Chạy một máy chủ DNS trên máy chủ gateway (truy cập được qua Tailnet).
2. Công bố các bản ghi DNS‑SD cho `_openclaw-gw._tcp` dưới một zone riêng
   (ví dụ: `openclaw.internal.`).
3. Cấu hình **split DNS** của Tailscale để domain đã chọn được phân giải qua
   máy chủ DNS đó cho các máy khách (bao gồm iOS).

OpenClaw supports any discovery domain; `openclaw.internal.` is just an example.
iOS/Android nodes browse both `local.` and your configured wide‑area domain.

### Cấu hình Gateway (khuyến nghị)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### Thiết lập máy chủ DNS một lần (máy chủ gateway)

```bash
openclaw dns setup --apply
```

Thiết lập này cài CoreDNS và cấu hình để:

- lắng nghe cổng 53 chỉ trên các giao diện Tailscale của gateway
- phục vụ domain đã chọn (ví dụ: `openclaw.internal.`) từ `~/.openclaw/dns/<domain>.db`

Xác thực từ một máy đã kết nối tailnet:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Cài đặt DNS của Tailscale

Trong bảng điều khiển quản trị Tailscale:

- Thêm một nameserver trỏ tới IP tailnet của gateway (UDP/TCP 53).
- Thêm split DNS để domain khám phá của bạn sử dụng nameserver đó.

Khi máy khách chấp nhận DNS tailnet, các node iOS có thể duyệt
`_openclaw-gw._tcp` trong domain khám phá của bạn mà không cần multicast.

### Bảo mật listener của Gateway (khuyến nghị)

The Gateway WS port (default `18789`) binds to loopback by default. For LAN/tailnet
access, bind explicitly and keep auth enabled.

Đối với thiết lập chỉ tailnet:

- Đặt `gateway.bind: "tailnet"` trong `~/.openclaw/openclaw.json`.
- Khởi động lại Gateway (hoặc khởi động lại ứng dụng menubar trên macOS).

## Thành phần quảng bá

Chỉ Gateway quảng bá `_openclaw-gw._tcp`.

## Loại dịch vụ

- `_openclaw-gw._tcp` — beacon truyền tải của gateway (được dùng bởi các node macOS/iOS/Android).

## Khóa TXT (gợi ý không bí mật)

Gateway quảng bá các gợi ý nhỏ không bí mật để giúp luồng UI thuận tiện:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (chỉ khi TLS được bật)
- `gatewayTlsSha256=<sha256>` (chỉ khi TLS được bật và có fingerprint)
- `canvasPort=<port>` (chỉ khi canvas host được bật; mặc định `18793`)
- `sshPort=<port>` (mặc định là 22 khi không ghi đè)
- `transport=gateway`
- `cliPath=<path>` (tùy chọn; đường dẫn tuyệt đối tới một entrypoint `openclaw` có thể chạy)
- `tailnetDns=<magicdns>` (gợi ý tùy chọn khi Tailnet khả dụng)

## Gỡ lỗi trên macOS

Các công cụ tích hợp hữu ích:

- Duyệt các instance:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Phân giải một instance (thay `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

Nếu duyệt hoạt động nhưng phân giải thất bại, thường là do chính sách LAN hoặc
vấn đề với trình phân giải mDNS.

## Gỡ lỗi trong log của Gateway

The Gateway writes a rolling log file (printed on startup as
`gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Gỡ lỗi trên node iOS

Node iOS sử dụng `NWBrowser` để khám phá `_openclaw-gw._tcp`.

Để thu thập log:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → tái hiện → **Copy**

Log bao gồm các chuyển trạng thái của trình duyệt và thay đổi tập kết quả.

## Các chế độ lỗi phổ biến

- **Bonjour không vượt qua mạng**: dùng Tailnet hoặc SSH.
- **Multicast bị chặn**: một số mạng Wi‑Fi vô hiệu hóa mDNS.
- **Ngủ / thay đổi giao diện**: macOS có thể tạm thời làm rớt kết quả mDNS; hãy thử lại.
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. The service instance name derives from
  the host name, so overly complex names can confuse some resolvers.

## Tên instance đã escape (`\032`)

Bonjour/DNS‑SD thường escape các byte trong tên instance dịch vụ thành các chuỗi
`\DDD` dạng thập phân (ví dụ: dấu cách trở thành `\032`).

- Đây là hành vi bình thường ở mức giao thức.
- UI nên giải mã để hiển thị (iOS dùng `BonjourEscapes.decode`).

## Vô hiệu hóa / cấu hình

- `OPENCLAW_DISABLE_BONJOUR=1` vô hiệu hóa quảng bá (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `gateway.bind` trong `~/.openclaw/openclaw.json` điều khiển chế độ bind của Gateway.
- `OPENCLAW_SSH_PORT` ghi đè cổng SSH được quảng bá trong TXT (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` công bố gợi ý MagicDNS trong TXT (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` ghi đè đường dẫn CLI được quảng bá (legacy: `OPENCLAW_CLI_PATH`).

## Tài liệu liên quan

- Chính sách khám phá và lựa chọn truyền tải: [Discovery](/gateway/discovery)
- Ghép cặp node + phê duyệt: [Gateway pairing](/gateway/pairing)
