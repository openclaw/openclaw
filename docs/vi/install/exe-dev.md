---
summary: "Chạy OpenClaw Gateway trên exe.dev (VM + proxy HTTPS) để truy cập từ xa"
read_when:
  - Bạn muốn một máy chủ Linux luôn bật với chi phí thấp cho Gateway
  - Bạn muốn truy cập Control UI từ xa mà không cần tự vận hành VPS
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:17Z
---

# exe.dev

Mục tiêu: OpenClaw Gateway chạy trên một VM exe.dev, có thể truy cập từ laptop của bạn thông qua: `https://<vm-name>.exe.xyz`

Trang này giả định bạn dùng image mặc định **exeuntu** của exe.dev. Nếu bạn chọn bản phân phối khác, hãy ánh xạ các gói tương ứng.

## Lối nhanh cho người mới

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Điền khóa/token xác thực của bạn khi được yêu cầu
3. Nhấp vào "Agent" bên cạnh VM của bạn và chờ…
4. ???
5. Có lãi

## Những gì bạn cần

- Tài khoản exe.dev
- Quyền truy cập `ssh exe.dev` vào máy ảo [exe.dev](https://exe.dev) (tùy chọn)

## Cài đặt tự động với Shelley

Shelley, tác tử của [exe.dev](https://exe.dev), có thể cài đặt OpenClaw ngay lập tức bằng prompt của chúng tôi.
Prompt được sử dụng như sau:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Cài đặt thủ công

## 1) Tạo VM

Từ thiết bị của bạn:

```bash
ssh exe.dev new
```

Sau đó kết nối:

```bash
ssh <vm-name>.exe.xyz
```

Mẹo: hãy giữ VM này ở trạng thái **stateful**. OpenClaw lưu trạng thái tại `~/.openclaw/` và `~/.openclaw/workspace/`.

## 2) Cài đặt các yêu cầu tiên quyết (trên VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Cài đặt OpenClaw

Chạy script cài đặt OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) Thiết lập nginx để proxy OpenClaw sang cổng 8000

Chỉnh sửa `/etc/nginx/sites-enabled/default` với

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) Truy cập OpenClaw và cấp quyền

Truy cập `https://<vm-name>.exe.xyz/` (xem đầu ra Control UI từ quá trình onboarding). Nếu hệ thống yêu cầu xác thực, hãy dán
token từ `gateway.auth.token` trên VM (lấy bằng `openclaw config get gateway.auth.token`, hoặc tạo mới bằng
`openclaw doctor --generate-gateway-token`). Phê duyệt thiết bị bằng `openclaw devices list` và
`openclaw devices approve <requestId>`. Khi không chắc chắn, hãy dùng Shelley trực tiếp từ trình duyệt của bạn!

## Truy cập từ xa

Truy cập từ xa được xử lý thông qua xác thực của [exe.dev](https://exe.dev). Theo
mặc định, lưu lượng HTTP từ cổng 8000 sẽ được chuyển tiếp tới `https://<vm-name>.exe.xyz`
với xác thực qua email.

## Cập nhật

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Hướng dẫn: [Updating](/install/updating)
