---
summary: "在 GCP Compute Engine VM (Docker) 上全天候運行具有持久狀態的 OpenClaw Gateway"
read_when:
  - 您希望在 GCP 上全天候運行 OpenClaw
  - 您希望在自己的 VM 上運行一個生產等級、全天候開啟的 Gateway
  - 您希望完全控制持久化、二進位檔案和重啟行為
title: "GCP"
---

# 在 GCP Compute Engine 上運行 OpenClaw (Docker, 正式環境 VPS 指南)

## 目標

在 GCP Compute Engine VM 上使用 Docker 運行一個持久的 OpenClaw Gateway，並具備持久化狀態、內建的二進位檔案和安全的重啟行為。

如果您想要「每月花費約 5-12 美元全天候運行 OpenClaw」，這是 Google Cloud 上一個可靠的設定。
價格會根據機器類型和區域而有所不同；請選擇適合您工作負載的最小 VM，並在遇到記憶體不足 (OOM) 時向上擴充。

## 我們要做什麼（簡單來說）？

- 建立 GCP 專案並啟用帳單功能
- 建立一個 Compute Engine VM
- 安裝 Docker（隔離的應用程式執行環境）
- 在 Docker 中啟動 OpenClaw Gateway
- 在主機上持久化 `~/.openclaw` + `~/.openclaw/workspace`（在重啟/重新建置後仍可保留）
- 透過 SSH 通道從您的筆記型電腦存取控制介面

可以透過以下方式存取 Gateway：

- 從您的筆記型電腦進行 SSH 連接埠轉發
- 如果您自行管理防火牆和 tokens，則可以直接開放連接埠

本指南在 GCP Compute Engine 上使用 Debian。
Ubuntu 也可以使用；請相應地對應軟體包。
關於通用的 Docker 流程，請參閱 [Docker](/install/docker)。

---

## 快速路徑（針對經驗豐富的操作者）

1. 建立 GCP 專案 + 啟用 Compute Engine API
2. 建立 Compute Engine VM (e2-small, Debian 12, 20GB)
3. 透過 SSH 進入 VM
4. 安裝 Docker
5. 複製 (Clone) OpenClaw 儲存庫
6. 建立持久化主機目錄
7. 設定 `.env` 和 `docker-compose.yml`
8. 內建所需的二進位檔案，建置並啟動

---

## 您需要準備

- GCP 帳號（e2-micro 適用於免費層級）
- 已安裝 gcloud CLI（或使用 Cloud Console）
- 從您的筆記型電腦進行 SSH 存取
- 基本的 SSH 操作和複製/貼上能力
- 約 20-30 分鐘
- Docker 和 Docker Compose
- 模型驗證憑證
- 選用的供應商憑證
  - WhatsApp QR Code
  - Telegram 機器人權杖 (bot token)
  - Gmail OAuth

---

## 1) 安裝 gcloud CLI（或使用 Console）

**選項 A：gcloud CLI**（建議用於自動化）

從 [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) 安裝

初始化並進行驗證：

```bash
gcloud init
gcloud auth login
```

**選項 B：Cloud Console**

所有步驟都可以透過 [https://console.cloud.google.com](https://console.cloud.google.com) 的網頁介面完成

---

## 2) 建立 GCP 專案

**CLI：**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

在 [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) 啟用帳單功能（Compute Engine 必備）。

啟用 Compute Engine API：

```bash
gcloud services enable compute.googleapis.com
```

**Console：**

1. 前往 IAM 與管理 > 建立專案
2. 命名並建立
3. 為該專案啟用帳單功能
4. 導覽至 API 與服務 > 啟用 API > 搜尋 "Compute Engine API" > 啟用

---

## 3) 建立 VM

**機器類型：**

| 類型     | 規格                   | 費用         | 備註               |
| -------- | ---------------------- | ------------ | ------------------ |
| e2-small | 2 vCPU, 2GB RAM        | 每月約 $12   | 建議選項           |
| e2-micro | 2 vCPU (共享), 1GB RAM | 適用免費層級 | 負載下可能發生 OOM |

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
3. 區域：`us-central1`，區域 (Zone)：`us-central1-a`
4. 機器類型：`e2-small`
5. 啟動磁碟：Debian 12, 20GB
6. 建立

---

## 4) 透過 SSH 進入 VM

**CLI：**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console：**

點擊 Compute Engine 儀表板中 VM 旁邊的 "SSH" 按鈕。

注意：VM 建立後，SSH 金鑰傳播可能需要 1-2 分鐘。如果連線被拒絕，請稍候並重試。

---

## 5) 安裝 Docker（在 VM 上）

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

登出並重新登入以使群組變更生效：

```bash
exit
```

然後重新透過 SSH 進入：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

驗證：

```bash
docker --version
docker compose version
```

---

## 6) 複製 OpenClaw 儲存庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設您將建置自訂映像檔以確保二進位檔案的持久化。

---

## 7) 建立持久化主機目錄

Docker 容器是暫時性的。
所有長久保存的狀態必須儲存在主機上。

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) 設定環境變數

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

產生強大的密鑰：

```bash
openssl rand -hex 32
```

**請勿提交此檔案。**

---

## 9) Docker Compose 設定

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
      # 建議：讓 Gateway 在 VM 上僅限 local loopback；透過 SSH 通道存取。
      # 若要公開存取，請移除 `127.0.0.1:` 前綴並相應地設定防火牆。
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # 選用：僅當您針對此 VM 運行 iOS/Android 節點且需要 Canvas 主機時才需要。
      # 如果您公開存取此連接埠，請閱讀 /gateway/security 並相應地設定防火牆。
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

## 10) 將所需的二進位檔案內建至映像檔（關鍵）

在運行的容器內安裝二進位檔案是一個陷阱。
任何在執行階段安裝的東西都會在重啟時遺失。

Skills 所需的所有外部二進位檔案都必須在映像檔建置時安裝。

下面的範例僅顯示三個常見的二進位檔案：

- 用於存取 Gmail 的 `gog`
- 用於 Google Places 的 `goplaces`
- 用於 WhatsApp 的 `wacli`

這些只是範例，並非完整清單。
您可以根據需要使用相同的模式安裝任意數量的二進位檔案。

如果您稍後添加了依賴於其他二進位檔案的新 Skills，您必須：

1. 更新 Dockerfile
2. 重新建置映像檔
3. 重啟容器

**Dockerfile 範例**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# 範例二進位檔案 1：Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 範例二進位檔案 2：Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 範例二進位檔案 3：WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 使用相同模式在下方添加更多二進位檔案

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

## 11) 建置並啟動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

驗證二進位檔案：

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

## 12) 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) 從您的筆記型電腦存取

建立 SSH 通道以轉發 Gateway 連接埠：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

在瀏覽器中開啟：

`http://127.0.0.1:18789/`

貼上您的 gateway token。

---

## 什麼東西持久化在哪裡（單一事實來源）

OpenClaw 運行在 Docker 中，但 Docker 並非單一事實來源。
所有長久保存的狀態都必須在重啟、重新建置和開機後留存。

| 組件              | 位置                              | 持久化機制        | 備註                           |
| ----------------- | --------------------------------- | ----------------- | ------------------------------ |
| Gateway 設定      | `/home/node/.openclaw/`           | 主機磁碟卷掛載    | 包含 `openclaw.json` 和 tokens |
| 模型驗證設定檔    | `/home/node/.openclaw/`           | 主機磁碟卷掛載    | OAuth 權杖、API 金鑰           |
| Skills 設定       | `/home/node/.openclaw/skills/`    | 主機磁碟卷掛載    | Skills 等級的狀態              |
| 智慧代理工作空間  | `/home/node/.openclaw/workspace/` | 主機磁碟卷掛載    | 程式碼和智慧代理成品           |
| WhatsApp 工作階段 | `/home/node/.openclaw/`           | 主機磁碟卷掛載    | 保留 QR Code 登入狀態          |
| Gmail keyring     | `/home/node/.openclaw/`           | 主機磁碟卷 + 密碼 | 需要 `GOG_KEYRING_PASSWORD`    |
| 外部二進位檔案    | `/usr/local/bin/`                 | Docker 映像檔     | 必須在建置時內建               |
| Node 執行環境     | 容器檔案系統                      | Docker 映像檔     | 每次建置映像檔時重新建置       |
| OS 軟體包         | 容器檔案系統                      | Docker 映像檔     | 請勿在執行階段安裝             |
| Docker 容器       | 暫時性的                          | 可重啟            | 銷毀是安全的                   |

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

## 疑難排解

**SSH 連線被拒絕**

VM 建立後，SSH 金鑰傳播可能需要 1-2 分鐘。請稍候並重試。

**OS Login 問題**

檢查您的 OS Login 設定檔：

```bash
gcloud compute os-login describe-profile
```

確保您的帳號具有所需的 IAM 權限（Compute OS Login 或 Compute OS Admin Login）。

**記憶體不足 (OOM)**

如果使用 e2-micro 並遇到 OOM，請升級至 e2-small 或 e2-medium：

```bash
# 先停止 VM
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# 變更機器類型
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# 啟動 VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## 服務帳戶（安全性最佳做法）

個人使用時，您的預設使用者帳號即可運作正常。

對於自動化或 CI/CD 管線，請建立一個具有最小權限的專用服務帳戶：

1. 建立服務帳戶：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. 授予 Compute Instance Admin 角色（或更精確的自訂角色）：

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

避免在自動化中使用 Owner 角色。請遵循最小權限原則。

關於 IAM 角色的詳細資訊，請參閱 [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)。

---

## 下一步

- 設定訊息頻道：[頻道](/channels)
- 將本地裝置配對為節點：[節點](/nodes)
- 設定 Gateway：[Gateway 設定](/gateway/configuration)
