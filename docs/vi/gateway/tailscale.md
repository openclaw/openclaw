---
summary: "Tích hợp Tailscale Serve/Funnel cho bảng điều khiển Gateway"
read_when:
  - Mở bảng điều khiển Gateway Control UI ra ngoài localhost
  - Tự động hóa quyền truy cập bảng điều khiển qua tailnet hoặc công khai
title: "Tailscale"
---

# Tailscale (bảng điều khiển Gateway)

OpenClaw can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the
Gateway dashboard and WebSocket port. This keeps the Gateway bound to loopback while
Tailscale provides HTTPS, routing, and (for Serve) identity headers.

## Chế độ

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`: Public HTTPS via `tailscale funnel`. OpenClaw requires a shared password.
- `off`: Mặc định (không tự động hóa Tailscale).

## Xác thực

Đặt `gateway.auth.mode` để kiểm soát bắt tay:

- `token` (mặc định khi `OPENCLAW_GATEWAY_TOKEN` được đặt)
- `password` (bí mật dùng chung qua `OPENCLAW_GATEWAY_PASSWORD` hoặc cấu hình)

When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
valid Serve proxy requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) without supplying a token/password. OpenClaw verifies
the identity by resolving the `x-forwarded-for` address via the local Tailscale
daemon (`tailscale whois`) and matching it to the header before accepting it.
OpenClaw only treats a request as Serve when it arrives from loopback with
Tailscale’s `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`
headers.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

## Ví dụ cấu hình

### Chỉ tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Mở: `https://<magicdns>/` (hoặc `gateway.controlUi.basePath` đã cấu hình của bạn)

### Chỉ tailnet (gắn vào IP Tailnet)

Dùng khi bạn muốn Gateway lắng nghe trực tiếp trên IP Tailnet (không dùng Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Kết nối từ một thiết bị Tailnet khác:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Lưu ý: loopback (`http://127.0.0.1:18789`) sẽ **không** hoạt động ở chế độ này.

### Internet công khai (Funnel + mật khẩu dùng chung)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Ưu tiên `OPENCLAW_GATEWAY_PASSWORD` thay vì ghi mật khẩu xuống đĩa.

## Ví dụ CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Ghi chú

- Tailscale Serve/Funnel yêu cầu cài đặt và đăng nhập CLI `tailscale`.
- `tailscale.mode: "funnel"` từ chối khởi động trừ khi chế độ xác thực là `password` để tránh phơi bày công khai.
- Đặt `gateway.tailscale.resetOnExit` nếu bạn muốn OpenClaw hoàn tác cấu hình `tailscale serve`
  hoặc `tailscale funnel` khi tắt.
- `gateway.bind: "tailnet"` là gắn Tailnet trực tiếp (không HTTPS, không Serve/Funnel).
- `gateway.bind: "auto"` ưu tiên loopback; dùng `tailnet` nếu bạn chỉ muốn Tailnet.
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over
  the same Gateway WS endpoint, so Serve can work for node access.

## Điều khiển trình duyệt (Gateway từ xa + trình duyệt cục bộ)

If you run the Gateway on one machine but want to drive a browser on another machine,
run a **node host** on the browser machine and keep both on the same tailnet.
The Gateway will proxy browser actions to the node; no separate control server or Serve URL needed.

Tránh dùng Funnel cho điều khiển trình duyệt; hãy coi việc ghép cặp node giống như quyền truy cập của người vận hành.

## Điều kiện tiên quyết + giới hạn của Tailscale

- Serve yêu cầu bật HTTPS cho tailnet của bạn; CLI sẽ nhắc nếu thiếu.
- Serve chèn các header định danh của Tailscale; Funnel thì không.
- Funnel yêu cầu Tailscale v1.38.3+, MagicDNS, bật HTTPS và thuộc tính funnel node.
- Funnel chỉ hỗ trợ các cổng `443`, `8443` và `10000` qua TLS.
- Funnel trên macOS yêu cầu biến thể ứng dụng Tailscale mã nguồn mở.

## Tìm hiểu thêm

- Tổng quan Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Lệnh `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tổng quan Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Lệnh `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
