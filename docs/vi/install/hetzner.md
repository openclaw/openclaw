---
summary: "Chạy OpenClaw Gateway 24/7 trên VPS Hetzner giá rẻ (Docker) với trạng thái bền vững và các binary được đóng gói sẵn"
read_when:
  - Bạn muốn OpenClaw chạy 24/7 trên một VPS đám mây (không phải laptop của bạn)
  - Bạn muốn một Gateway luôn bật, đạt chuẩn production trên VPS riêng của bạn
  - Bạn muốn toàn quyền kiểm soát việc lưu trữ lâu dài, các binary và hành vi khởi động lại
  - Bạn đang chạy OpenClaw trong Docker trên Hetzner hoặc nhà cung cấp tương tự
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:27Z
---

# OpenClaw trên Hetzner (Docker, Hướng dẫn VPS production)

## Mục tiêu

Chạy một OpenClaw Gateway bền vững trên VPS Hetzner bằng Docker, với trạng thái được lưu lâu dài, các binary được đóng gói sẵn và hành vi khởi động lại an toàn.

Nếu bạn muốn “OpenClaw 24/7 với ~$5”, đây là thiết lập đơn giản và đáng tin cậy nhất.  
Giá Hetzner có thể thay đổi; hãy chọn VPS Debian/Ubuntu nhỏ nhất và nâng cấp nếu gặp lỗi OOM.

## Chúng ta đang làm gì (nói đơn giản)?

- Thuê một máy chủ Linux nhỏ (VPS Hetzner)
- Cài Docker (môi trường chạy ứng dụng tách biệt)
- Khởi động OpenClaw Gateway trong Docker
- Lưu `~/.openclaw` + `~/.openclaw/workspace` trên máy chủ (tồn tại qua các lần restart/rebuild)
- Truy cập Control UI từ laptop của bạn qua đường hầm SSH

Gateway có thể được truy cập qua:

- Chuyển tiếp cổng SSH từ laptop của bạn
- Mở cổng trực tiếp nếu bạn tự quản lý firewall và token

Hướng dẫn này giả định bạn dùng Ubuntu hoặc Debian trên Hetzner.  
Nếu bạn dùng VPS Linux khác, hãy ánh xạ các gói tương ứng.  
Với luồng Docker chung, xem [Docker](/install/docker).

---

## Lộ trình nhanh (người vận hành có kinh nghiệm)

1. Tạo VPS Hetzner
2. Cài Docker
3. Clone repository OpenClaw
4. Tạo các thư mục host lưu trữ lâu dài
5. Cấu hình `.env` và `docker-compose.yml`
6. Đóng gói các binary cần thiết vào image
7. `docker compose up -d`
8. Xác minh tính bền vững và truy cập Gateway

---

## Những gì bạn cần

- VPS Hetzner với quyền root
- Truy cập SSH từ laptop của bạn
- Thoải mái cơ bản với SSH + copy/paste
- ~20 phút
- Docker và Docker Compose
- Thông tin xác thực mô hình
- Thông tin xác thực nhà cung cấp (tùy chọn)
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1) Tạo VPS

Tạo một VPS Ubuntu hoặc Debian trên Hetzner.

Kết nối với quyền root:

```bash
ssh root@YOUR_VPS_IP
```

Hướng dẫn này giả định VPS là có trạng thái (stateful).  
Không nên coi nó là hạ tầng dùng xong bỏ.

---

## 2) Cài Docker (trên VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Xác minh:

```bash
docker --version
docker compose version
```

---

## 3) Clone repository OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Hướng dẫn này giả định bạn sẽ build một image tùy chỉnh để đảm bảo binary được lưu bền vững.

---

## 4) Tạo các thư mục host lưu trữ lâu dài

Docker container là tạm thời.  
Mọi trạng thái tồn tại lâu dài phải nằm trên host.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Cấu hình biến môi trường

Tạo `.env` ở thư mục gốc của repository.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Tạo các secret mạnh:

```bash
openssl rand -hex 32
```

**Không commit file này.**

---

## 6) Cấu hình Docker Compose

Tạo hoặc cập nhật `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7) Đóng gói các binary cần thiết vào image (quan trọng)

Cài binary bên trong container đang chạy là một cái bẫy.  
Bất cứ thứ gì cài ở runtime sẽ bị mất khi restart.

Tất cả các binary bên ngoài mà Skills cần phải được cài ở bước build image.

Ví dụ dưới đây chỉ minh họa ba binary phổ biến:

- `gog` cho truy cập Gmail
- `goplaces` cho Google Places
- `wacli` cho WhatsApp

Đây chỉ là ví dụ, không phải danh sách đầy đủ.  
Bạn có thể cài bao nhiêu binary tùy ý theo cùng một mẫu.

Nếu sau này bạn thêm Skills mới phụ thuộc vào các binary khác, bạn phải:

1. Cập nhật Dockerfile
2. Rebuild image
3. Restart container

**Ví dụ Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8) Build và khởi chạy

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Xác minh các binary:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Đầu ra mong đợi:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Xác minh Gateway

```bash
docker compose logs -f openclaw-gateway
```

Thành công:

```
[gateway] listening on ws://0.0.0.0:18789
```

Từ laptop của bạn:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Mở:

`http://127.0.0.1:18789/`

Dán gateway token của bạn.

---

## Những gì được lưu ở đâu (nguồn sự thật)

OpenClaw chạy trong Docker, nhưng Docker không phải là nguồn sự thật.  
Mọi trạng thái tồn tại lâu dài phải sống sót qua restart, rebuild và reboot.

| Thành phần             | Vị trí                            | Cơ chế lưu trữ         | Ghi chú                        |
| ---------------------- | --------------------------------- | ---------------------- | ------------------------------ |
| Cấu hình Gateway       | `/home/node/.openclaw/`           | Gắn volume host        | Bao gồm `openclaw.json`, token |
| Hồ sơ xác thực mô hình | `/home/node/.openclaw/`           | Gắn volume host        | OAuth token, khóa API          |
| Cấu hình Skill         | `/home/node/.openclaw/skills/`    | Gắn volume host        | Trạng thái cấp Skill           |
| Workspace agent        | `/home/node/.openclaw/workspace/` | Gắn volume host        | Mã và artifact của agent       |
| Phiên WhatsApp         | `/home/node/.openclaw/`           | Gắn volume host        | Giữ đăng nhập QR               |
| Keyring Gmail          | `/home/node/.openclaw/`           | Volume host + mật khẩu | Yêu cầu `GOG_KEYRING_PASSWORD` |
| Binary bên ngoài       | `/usr/local/bin/`                 | Docker image           | Phải được đóng gói khi build   |
| Runtime Node           | Hệ thống file container           | Docker image           | Rebuild mỗi lần build image    |
| Gói OS                 | Hệ thống file container           | Docker image           | Không cài ở runtime            |
| Docker container       | Tạm thời                          | Có thể restart         | An toàn để xóa                 |
