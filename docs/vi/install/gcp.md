---
summary: "Chạy OpenClaw Gateway 24/7 trên VM GCP Compute Engine (Docker) với trạng thái bền vững"
read_when:
  - Bạn muốn OpenClaw chạy 24/7 trên GCP
  - Bạn muốn một Gateway luôn bật, đạt chuẩn production trên VM riêng
  - Bạn muốn toàn quyền kiểm soát lưu trữ, nhị phân và hành vi khởi động lại
title: "GCP"
---

# OpenClaw trên GCP Compute Engine (Docker, Hướng dẫn VPS production)

## Mục tiêu

Chạy một OpenClaw Gateway bền vững trên VM GCP Compute Engine bằng Docker, với trạng thái lưu trữ lâu dài, nhị phân được bake sẵn và hành vi khởi động lại an toàn.

If you want "OpenClaw 24/7 for ~$5-12/mo", this is a reliable setup on Google Cloud.
Pricing varies by machine type and region; pick the smallest VM that fits your workload and scale up if you hit OOMs.

## Chúng ta đang làm gì (giải thích đơn giản)?

- Tạo một dự án GCP và bật thanh toán
- Tạo một VM Compute Engine
- Cài Docker (môi trường chạy ứng dụng tách biệt)
- Khởi chạy OpenClaw Gateway trong Docker
- Lưu `~/.openclaw` + `~/.openclaw/workspace` trên host (tồn tại qua restart/rebuild)
- Truy cập Control UI từ laptop qua đường hầm SSH

Gateway có thể được truy cập qua:

- Chuyển tiếp cổng SSH từ laptop
- Mở cổng trực tiếp nếu bạn tự quản lý firewall và token

This guide uses Debian on GCP Compute Engine.
Ubuntu cũng hoạt động; hãy ánh xạ các gói cho phù hợp.
Đối với luồng Docker chung, xem [Docker](/install/docker).

---

## Lối nhanh (cho người đã có kinh nghiệm)

1. Tạo dự án GCP + bật Compute Engine API
2. Tạo VM Compute Engine (e2-small, Debian 12, 20GB)
3. SSH vào VM
4. Cài Docker
5. Clone repository OpenClaw
6. Tạo các thư mục host bền vững
7. Cấu hình `.env` và `docker-compose.yml`
8. Bake nhị phân cần thiết, build và khởi chạy

---

## Những gì bạn cần

- Tài khoản GCP (free tier dùng được cho e2-micro)
- gcloud CLI đã cài (hoặc dùng Cloud Console)
- Quyền SSH từ laptop
- Thoải mái cơ bản với SSH + copy/paste
- ~20–30 phút
- Docker và Docker Compose
- Thông tin xác thực mô hình
- Thông tin xác thực nhà cung cấp (tùy chọn)
  - QR WhatsApp
  - Token bot Telegram
  - OAuth Gmail

---

## 1. Cài gcloud CLI (hoặc dùng Console)

**Tùy chọn A: gcloud CLI** (khuyến nghị cho tự động hóa)

Cài đặt từ [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Khởi tạo và xác thực:

```bash
gcloud init
gcloud auth login
```

**Tùy chọn B: Cloud Console**

Tất cả các bước có thể thực hiện qua web UI tại [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Tạo dự án GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Bật thanh toán tại [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (bắt buộc cho Compute Engine).

Bật Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Vào IAM & Admin > Create Project
2. Đặt tên và tạo
3. Bật thanh toán cho dự án
4. Vào APIs & Services > Enable APIs > tìm “Compute Engine API” > Enable

---

## 3. Tạo VM

**Các loại máy:**

| Type     | Specs                                        | Cost                       | Notes                  |
| -------- | -------------------------------------------- | -------------------------- | ---------------------- |
| e2-small | 2 vCPU, 2GB RAM                              | ~$12/tháng | Khuyến nghị            |
| e2-micro | 2 vCPU (chia sẻ), 1GB RAM | Đủ điều kiện free tier     | Có thể OOM khi tải cao |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Vào Compute Engine > VM instances > Create instance
2. Name: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4. SSH vào VM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Nhấn nút “SSH” bên cạnh VM trong bảng điều khiển Compute Engine.

Lưu ý: Việc lan truyền khóa SSH có thể mất 1–2 phút sau khi tạo VM. If connection is refused, wait and retry.

---

## 5. Cài Docker (trên VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Đăng xuất và đăng nhập lại để thay đổi nhóm có hiệu lực:

```bash
exit
```

Sau đó SSH lại:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Kiểm tra:

```bash
docker --version
docker compose version
```

---

## 6. Clone repository OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Hướng dẫn này giả định bạn sẽ build image tùy chỉnh để đảm bảo nhị phân được lưu bền vững.

---

## 7. Tạo các thư mục host bền vững

Docker containers are ephemeral.
All long-lived state must live on the host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Cấu hình biến môi trường

Tạo `.env` ở thư mục gốc của repository.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Tạo secret mạnh:

```bash
openssl rand -hex 32
```

**Không commit file này.**

---

## 9. Cấu hình Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10. Bake nhị phân cần thiết vào image (quan trọng)

Installing binaries inside a running container is a trap.
Bất kỳ thứ gì được cài đặt lúc runtime sẽ bị mất khi khởi động lại.

Tất cả nhị phân bên ngoài mà Skills cần phải được cài ở thời điểm build image.

Các ví dụ dưới đây chỉ minh họa ba nhị phân phổ biến:

- `gog` để truy cập Gmail
- `goplaces` cho Google Places
- `wacli` cho WhatsApp

Hỗ trợ macOS và Linux (bao gồm WSL).
You may install as many binaries as needed using the same pattern.

Nếu sau này bạn thêm Skills mới phụ thuộc vào nhị phân khác, bạn phải:

1. Cập nhật Dockerfile
2. Build lại image
3. Khởi động lại container

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

## 11. Build và khởi chạy

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Kiểm tra nhị phân:

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

## 12. Xác minh Gateway

```bash
docker compose logs -f openclaw-gateway
```

Thành công:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Truy cập từ laptop của bạn

Tạo đường hầm SSH để chuyển tiếp cổng Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Mở trong trình duyệt:

`http://127.0.0.1:18789/`

Dán gateway token của bạn.

---

## Dữ liệu nào được lưu ở đâu (nguồn chân lý)

OpenClaw runs in Docker, but Docker is not the source of truth.
All long-lived state must survive restarts, rebuilds, and reboots.

| Thành phần             | Vị trí                            | Cơ chế lưu bền vững    | Notes                          |
| ---------------------- | --------------------------------- | ---------------------- | ------------------------------ |
| Cấu hình Gateway       | `/home/node/.openclaw/`           | Gắn volume host        | Bao gồm `openclaw.json`, token |
| Hồ sơ xác thực mô hình | `/home/node/.openclaw/`           | Gắn volume host        | Token OAuth, khóa API          |
| Cấu hình Skill         | `/home/node/.openclaw/skills/`    | Gắn volume host        | Trạng thái theo Skill          |
| Workspace tác tử       | `/home/node/.openclaw/workspace/` | Gắn volume host        | Mã và artifact của tác tử      |
| Phiên WhatsApp         | `/home/node/.openclaw/`           | Gắn volume host        | Giữ đăng nhập QR               |
| Keyring Gmail          | `/home/node/.openclaw/`           | Volume host + mật khẩu | Cần `GOG_KEYRING_PASSWORD`     |
| Nhị phân bên ngoài     | `/usr/local/bin/`                 | Docker image           | Phải bake khi build            |
| Runtime Node           | Hệ thống file container           | Docker image           | Build lại mỗi lần build image  |
| Gói hệ điều hành       | Hệ thống file container           | Docker image           | Không cài ở runtime            |
| Container Docker       | Tạm thời                          | Có thể restart         | An toàn khi xóa                |

---

## Cập nhật

Để cập nhật OpenClaw trên VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Xử lý sự cố

**SSH connection refused**

Việc lan truyền khóa SSH có thể mất 1–2 phút sau khi tạo VM. Hãy đợi và thử lại.

**Vấn đề OS Login**

Kiểm tra hồ sơ OS Login của bạn:

```bash
gcloud compute os-login describe-profile
```

Đảm bảo tài khoản của bạn có quyền IAM cần thiết (Compute OS Login hoặc Compute OS Admin Login).

**Hết bộ nhớ (OOM)**

Nếu dùng e2-micro và gặp OOM, hãy nâng cấp lên e2-small hoặc e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Service accounts (thực hành bảo mật tốt)

Với mục đích cá nhân, tài khoản người dùng mặc định của bạn là đủ.

Với tự động hóa hoặc pipeline CI/CD, hãy tạo một service account riêng với quyền tối thiểu:

1. Tạo service account:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Cấp vai trò Compute Instance Admin (hoặc vai trò tùy chỉnh hẹp hơn):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Avoid using the Owner role for automation. Use the principle of least privilege.

Xem [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) để biết chi tiết về vai trò IAM.

---

## Bước tiếp theo

- Thiết lập các kênh nhắn tin: [Channels](/channels)
- Ghép nối thiết bị cục bộ làm node: [Nodes](/nodes)
- Cấu hình Gateway: [Gateway configuration](/gateway/configuration)
