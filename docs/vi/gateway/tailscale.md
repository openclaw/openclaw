---
summary: "Tích hợp Tailscale Serve/Funnel cho bảng điều khiển Gateway"
read_when:
  - Mở bảng điều khiển Gateway Control UI ra ngoài localhost
  - Tự động hóa quyền truy cập bảng điều khiển qua tailnet hoặc công khai
title: "Tailscale"
x-i18n:
  source_path: gateway/tailscale.md
  source_hash: c4842b10848d4fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:11Z
---

# Tailscale (bảng điều khiển Gateway)

OpenClaw có thể tự động cấu hình Tailscale **Serve** (tailnet) hoặc **Funnel** (công khai) cho
bảng điều khiển Gateway và cổng WebSocket. Cách này giữ Gateway chỉ gắn với loopback trong khi
Tailscale cung cấp HTTPS, định tuyến và (đối với Serve) các header định danh.

## Chế độ

- `serve`: Serve chỉ trong tailnet qua `tailscale serve`. Gateway vẫn ở `127.0.0.1`.
- `funnel`: HTTPS công khai qua `tailscale funnel`. OpenClaw yêu cầu mật khẩu dùng chung.
- `off`: Mặc định (không tự động hóa Tailscale).

## Xác thực

Đặt `gateway.auth.mode` để kiểm soát bắt tay:

- `token` (mặc định khi `OPENCLAW_GATEWAY_TOKEN` được đặt)
- `password` (bí mật dùng chung qua `OPENCLAW_GATEWAY_PASSWORD` hoặc cấu hình)

Khi `tailscale.mode = "serve"` và `gateway.auth.allowTailscale` là `true`,
các yêu cầu proxy Serve hợp lệ có thể xác thực qua header định danh của Tailscale
(`tailscale-user-login`) mà không cần cung cấp token/mật khẩu. OpenClaw xác minh
định danh bằng cách phân giải địa chỉ `x-forwarded-for` qua daemon Tailscale cục bộ
(`tailscale whois`) và đối chiếu với header trước khi chấp nhận.
OpenClaw chỉ coi một yêu cầu là Serve khi nó đến từ loopback với các header
`x-forwarded-for`, `x-forwarded-proto` và `x-forwarded-host` của Tailscale.
Để yêu cầu thông tin xác thực tường minh, hãy đặt `gateway.auth.allowTailscale: false` hoặc
ép buộc `gateway.auth.mode: "password"`.

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
- Serve/Funnel chỉ mở **UI điều khiển Gateway + WS**. Các node kết nối qua cùng endpoint WS của Gateway, vì vậy Serve có thể hoạt động cho truy cập node.

## Điều khiển trình duyệt (Gateway từ xa + trình duyệt cục bộ)

Nếu bạn chạy Gateway trên một máy nhưng muốn điều khiển trình duyệt trên máy khác,
hãy chạy một **node host** trên máy có trình duyệt và giữ cả hai trong cùng tailnet.
Gateway sẽ proxy các thao tác trình duyệt tới node; không cần máy chủ điều khiển riêng hay URL Serve riêng.

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
