---
summary: "在 GCP Compute Engine VM（Docker）上 24/7 執行 OpenClaw Gateway，並具備耐久狀態"
read_when:
  - 你希望在 GCP 上 24/7 執行 OpenClaw
  - 你想要在自己的 VM 上部署生產等級、永遠在線的 Gateway
  - 你希望完全掌控持久化、二進位檔與重新啟動行為
title: "GCP"
---

# 在 GCP Compute Engine 上執行 OpenClaw（Docker，生產 VPS 指南）

## 目標

使用 Docker 在 GCP Compute Engine VM 上執行一個具備持久狀態、內建二進位檔且可安全重啟的 OpenClaw Gateway。

如果你想要「每月約 ~$5–12 就能 24/7 執行 OpenClaw」，這是在 Google Cloud 上可靠的設定方式。  
費用會依機器類型與區域而異；請選擇能滿足工作負載的最小 VM，若遇到 OOM 再向上擴充。
價格依機器類型與地區而異；選擇能滿足工作負載的最小 VM，若遇到 OOM 再向上擴充。

## 我們在做什麼（白話說明）？

- 建立 GCP 專案並啟用計費
- 建立 Compute Engine VM
- 安裝 Docker（隔離的應用程式執行環境）
- 在 Docker 中啟動 OpenClaw Gateway
- 在主機上持久化 `~/.openclaw` + `~/.openclaw/workspace`（可在重啟／重建後保留）
- 透過 SSH 通道，從你的筆電存取控制 UI

Gateway 可透過以下方式存取：

- 從你的筆電使用 SSH 連接埠轉送
- 若你自行管理防火牆與權杖，可直接曝露連接埠

This guide uses Debian on GCP Compute Engine.
Ubuntu also works; map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## 快速路徑（有經驗的操作人員）

1. 建立 GCP 專案並啟用 Compute Engine API
2. 建立 Compute Engine VM（e2-small、Debian 12、20GB）
3. SSH 連線至 VM
4. 安裝 Docker
5. 複製 OpenClaw 儲存庫
6. 建立持久化的主機目錄
7. 設定 `.env` 與 `docker-compose.yml`
8. Bake required binaries, build, and launch

---

## What you need

- GCP 帳戶（e2-micro 可使用免費額度）
- 已安裝 gcloud CLI（或使用 Cloud Console）
- 從你的筆電進行 SSH 存取
- 基本的 SSH 與複製／貼上操作能力
- 約 20–30 分鐘
- Docker 與 Docker Compose
- 模型身分驗證憑證
- 選用的提供者憑證
  - WhatsApp QR
  - Telegram 機器人權杖
  - Gmail OAuth

---

## 1. 安裝 gcloud CLI（或使用 Console）

**選項 A：gcloud CLI**（建議用於自動化）

請依照 [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) 安裝。

初始化並進行驗證：

```bash
gcloud init
gcloud auth login
```

**選項 B：Cloud Console**

所有步驟皆可透過網頁介面完成：[https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. 建立 GCP 專案

**CLI：**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

請至 [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) 啟用計費（Compute Engine 需要）。

啟用 Compute Engine API：

```bash
gcloud services enable compute.googleapis.com
```

**Console：**

1. 前往 IAM 與管理 > 建立專案
2. 命名並建立
3. Enable billing for the project
4. 前往 API 與服務 > 啟用 API > 搜尋「Compute Engine API」> 啟用

---

## 3. 建立 VM

**機器類型：**

| 類型       | 規格                 | 費用                       | 注意事項       |
| -------- | ------------------ | ------------------------ | ---------- |
| e2-small | 2 vCPU，2GB RAM     | 約 ~$12/月 | 建議         |
| e2-micro | 2 vCPU（共享），1GB RAM | 符合免費額度                   | 高負載時可能 OOM |

**CLI：**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console：**

1. 前往 Compute Engine > VM 執行個體 > 建立執行個體
2. 名稱：`openclaw-gateway`
3. 區域：`us-central1`，可用區：`us-central1-a`
4. 機器類型：`e2-small`
5. 開機磁碟：Debian 12，20GB
6. 建立

---

## 4. SSH 連線至 VM

**CLI：**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console：**

在 Compute Engine 儀表板中，點擊 VM 旁的「SSH」按鈕。

注意：VM 建立後，SSH 金鑰同步可能需要 1–2 分鐘。若連線被拒，請稍候再試。 If connection is refused, wait and retry.

---

## 5. 在 VM 上安裝 Docker

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

登出後再登入，使群組變更生效：

```bash
exit
```

接著重新 SSH 連線：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

驗證：

```bash
docker --version
docker compose version
```

---

## 6. 複製 OpenClaw 儲存庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

This guide assumes you will build a custom image to guarantee binary persistence.

---

## 7. 建立持久化的主機目錄

Docker 容器是短暫的。
All long-lived state must live on the host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. 設定環境變數

在儲存庫根目錄建立 `.env`。

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

產生高強度的祕密值：

```bash
openssl rand -hex 32
```

**請勿提交此檔案。**

---

## 9. Docker Compose 設定

建立或更新 `docker-compose.yml`。

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

## 10. 將必要的二進位檔烘焙進映像檔（關鍵）

Installing binaries inside a running container is a trap.
任何在執行期間安裝的內容都會在重新啟動時遺失。

技能所需的所有外部二進位檔都必須在映像建置時安裝。

以下範例僅示範三種常見的二進位檔：

- 用於 Gmail 存取的 `gog`
- 用於 Google Places 的 `goplaces`
- 用於 WhatsApp 的 `wacli`

These are examples, not a complete list.
You may install as many binaries as needed using the same pattern.

若日後新增依賴其他二進位檔的 Skills，你必須：

1. 更新 Dockerfile
2. 重新建置映像檔
3. 重新啟動容器

**Dockerfile 範例**

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

## 11. 建置並啟動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

驗證二進位檔：

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

預期輸出：

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功畫面：

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. 從你的筆電存取

建立 SSH 通道以轉送 Gateway 連接埠：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

在瀏覽器中開啟：

`http://127.0.0.1:18789/`

貼上你的閘道權杖。

---

## What persists where (source of truth)

OpenClaw 在 Docker 中執行，但 Docker 並非單一事實來源。  
所有長期狀態都必須能在重啟、重建與重新開機後存活。
All long-lived state must survive restarts, rebuilds, and reboots.

| 元件            | 位置                                | 持久化機制             | 注意事項                      |
| ------------- | --------------------------------- | ----------------- | ------------------------- |
| Gateway 設定    | `/home/node/.openclaw/`           | Host volume mount | 包含 `openclaw.json`、權杖     |
| 模型身分驗證設定      | `/home/node/.openclaw/`           | 主機磁碟區掛載           | OAuth 權杖、API 金鑰           |
| Skill 設定      | `/home/node/.openclaw/skills/`    | Host volume mount | Skill 層級狀態                |
| 代理程式工作區       | `/home/node/.openclaw/workspace/` | Host volume mount | 程式碼與代理程式產物                |
| WhatsApp 工作階段 | `/home/node/.openclaw/`           | Host volume mount | 保留 QR 登入                  |
| Gmail 金鑰圈     | `/home/node/.openclaw/`           | 主機 Volume + 密碼    | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二進位檔        | `/usr/local/bin/`                 | Docker 映像檔        | 必須在建置時烘焙                  |
| Node 執行環境     | 容器檔案系統                            | Docker 映像檔        | 每次映像檔建置都會重建               |
| OS 套件         | 容器檔案系統                            | Docker 映像檔        | 請勿在執行期安裝                  |
| Docker 容器     | 暫時性                               | 可重新啟動             | 可安全銷毀                     |

---

## 更新

要在 VM 上更新 OpenClaw：

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Troubleshooting

**SSH 連線被拒**

VM 建立後，SSH 金鑰同步可能需要 1–2 分鐘。請稍候再試。 Wait and retry.

**OS Login 問題**

檢查你的 OS Login 設定：

```bash
gcloud compute os-login describe-profile
```

確認你的帳戶具備所需的 IAM 權限（Compute OS Login 或 Compute OS Admin Login）。

**記憶體不足（OOM）**

若使用 e2-micro 發生 OOM，請升級至 e2-small 或 e2-medium：

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

## 服務帳戶（安全性最佳實務）

For personal use, your default user account works fine.

對於自動化或 CI/CD 管線，請建立具備最小權限的專用服務帳戶：

1. 建立服務帳戶：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. 授與 Compute Instance Admin 角色（或更精簡的自訂角色）：

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

避免在自動化中使用 Owner 角色，請遵循最小權限原則。 3. 使用最小權限原則。

IAM 角色細節請參考  
[https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)

---

## 後續步驟

- 設定訊息頻道：[Channels](/channels)
- 將本地裝置配對為節點：[Nodes](/nodes)
- 設定 Gateway：[Gateway configuration](/gateway/configuration)
