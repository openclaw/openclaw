---
summary: "在 GCP Compute Engine 虛擬機器 (Docker) 上以持久狀態全天候執行 OpenClaw Gateway"
read_when:
  - 您希望 OpenClaw 在 GCP 上全天候運行
  - 您希望在自己的虛擬機器上擁有一個生產級、永遠在線的 Gateway
  - 您希望完全控制持久性、二進位檔案和重啟行為
title: "GCP"
---

# 在 GCP Compute Engine 上執行 OpenClaw (Docker, 生產級 VPS 指南)

## 目標

在 GCP Compute Engine 虛擬機器上使用 Docker 執行一個持久的 OpenClaw Gateway，並具有持久狀態、內建二進位檔案和安全的重啟行為。

如果您想要「全天候 OpenClaw，每月費用約 $5-12」，這是在 Google Cloud 上一個可靠的設定。
價格會因機器類型和區域而異；選擇適合您工作負載的最小虛擬機器，如果遇到記憶體不足 (OOM) 的情況再擴展。

## 我們要做什麼 (簡單來說)？

- 建立一個 GCP 專案並啟用計費
- 建立一個 Compute Engine 虛擬機器
- 安裝 Docker (隔離的應用程式執行環境)
- 在 Docker 中啟動 OpenClaw Gateway
- 在主機上持久化 `~/.openclaw` + `~/.openclaw/workspace` (在重啟/重建後仍保留)
- 透過 SSH 通道從您的筆記型電腦存取控制使用者介面

Gateway 可以透過以下方式存取：

- 從您的筆記型電腦進行 SSH 埠轉發
- 如果您自行管理防火牆和權杖，則可直接公開埠

本指南使用 GCP Compute Engine 上的 Debian。
Ubuntu 也適用；請相應地對應套件。
有關通用 Docker 流程，請參閱 [Docker](/install/docker)。

---

## 快速路徑 (經驗豐富的操作員)

1. 建立 GCP 專案 + 啟用 Compute Engine API
2. 建立 Compute Engine 虛擬機器 (e2-small, Debian 12, 20GB)
3. SSH 連線到虛擬機器
4. 安裝 Docker
5. 克隆 OpenClaw 儲存庫
6. 建立持久的主機目錄
7. 設定 `.env` 和 `docker-compose.yml`
8. 烘焙所需的二進位檔案、建置並啟動

---

## 您需要什麼

- GCP 帳號 (e2-micro 符合免費方案資格)
- 已安裝 gcloud CLI (或使用 Cloud Console)
- 從您的筆記型電腦進行 SSH 存取
- 基本的 SSH + 複製/貼上操作能力
- 約 20-30 分鐘
- Docker 和 Docker Compose
- 模型驗證憑證
- 選用的供應商憑證
  - WhatsApp QR
  - Telegram 機器人權杖
  - Gmail OAuth

---

## 1) 安裝 gcloud CLI (或使用 Console)

**選項 A: gcloud CLI** (推薦用於自動化)

從 [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) 安裝

初始化並驗證：

```bash
gcloud init
gcloud auth login
```

**選項 B: Cloud Console**

所有步驟都可以透過 [https://console.cloud.google.com](https://console.cloud.google.com) 上的網頁使用者介面完成

---

## 2) 建立 GCP 專案

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

在 [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) 啟用計費 (Compute Engine 需要)。

啟用 Compute Engine API：

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. 前往 IAM & Admin > 建立專案
2. 命名並建立
3. 為專案啟用計費
4. 導覽至 API 與服務 > 啟用 API > 搜尋「Compute Engine API」> 啟用

---

## 3) 建立虛擬機器

**機器類型：**

| 類型     | 規格                    | 費用               | 備註              |
| -------- | ------------------------ | ------------------ | ------------------ |
| e2-small | 2 個虛擬 CPU，2GB 記憶體 | 約 $12/月            | 推薦               |
| e2-micro | 2 個虛擬 CPU (共用)，1GB 記憶體 | 符合免費方案資格     | 在負載下可能會記憶體不足 |

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

1. 前往 Compute Engine > 虛擬機器實例 > 建立實例
2. 名稱：`openclaw-gateway`
3. 區域：`us-central1`，區域：`us-central1-a`
4. 機器類型：`e2-small`
5. 開機磁碟：Debian 12, 20GB
6. 建立

---

## 4) SSH 連線到虛擬機器

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

點擊 Compute Engine 資訊主頁中虛擬機器旁邊的「SSH」按鈕。

備註：SSH 金鑰傳播可能在虛擬機器建立後需要 1-2 分鐘。如果連線被拒絕，請稍候再試。

---

## 5) 安裝 Docker (在虛擬機器上)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

登出並重新登入，使群組變更生效：

```bash
exit
```

然後重新 SSH 連線：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

驗證：

```bash
docker --version
docker compose version
```

---

## 6) 克隆 OpenClaw 儲存庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設您將建置自訂映像檔以確保二進位檔案的持久性。

---

## 7) 建立持久的主機目錄

Docker 容器是暫時性的。
所有長期存在的狀態都必須位於主機上。

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) 設定環境變數

在儲存庫根目錄中建立 `.env` 檔案。

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
      # 推薦：將 Gateway 保持在虛擬機器上的 local loopback 模式；透過 SSH 通道存取。
      # 若要公開暴露，請移除 `127.0.0.1:` 前綴並相應地設定防火牆。
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # 選用：僅當您針對此虛擬機器執行 iOS/Android 節點並需要 Canvas 主機時。
      # 如果您公開暴露此服務，請閱讀 /gateway/security 並相應地設定防火牆。
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

## 10) 將所需的二進位檔案烘焙到映像檔中 (關鍵)

在運行的容器中安裝二進位檔案是一個陷阱。
在運行時安裝的任何東西都將在重啟時丟失。

技能所需的所有外部二進位檔案都必須在映像檔建置時安裝。

下面的範例僅顯示三個常見的二進位檔案：

- `gog` 用於 Gmail 存取
- `goplaces` 用於 Google Places
- `wacli` 用於 WhatsApp

這些只是範例，並非完整列表。
您可以使用相同的模式安裝任意數量的二進位檔案。

如果您稍後添加依賴於其他二進位檔案的新技能，您必須：

1. 更新 Dockerfile
2. 重建映像檔
3. 重啟容器

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

建立一個 SSH 通道以轉發 Gateway 埠：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

在您的瀏覽器中開啟：

`http://127.0.0.1:18789/`

貼上您的 gateway 權杖。

---

## 哪些內容會持續存在 (真相來源)

OpenClaw 在 Docker 中運行，但 Docker 並非真相來源。
所有長期存在的狀態都必須在重啟、重建和重開機後仍保留。

| 元件           | 位置                          | 持久機制           | 備註                            |
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Gateway 設定      | `/home/node/.openclaw/`           | 主機磁碟區掛載      | 包括 `openclaw.json`、權杖    |
| 模型驗證設定檔 | `/home/node/.openclaw/`           | 主機磁碟區掛載      | OAuth 權杖、API 金鑰           |
| 技能設定       | `/home/node/.openclaw/skills/`    | 主機磁碟區掛載      | 技能級別的狀態                |
| 智慧代理工作區     | `/home/node/.openclaw/workspace/` | 主機磁碟區掛載      | 程式碼和智慧代理產物         |
| WhatsApp 工作階段    | `/home/node/.openclaw/`           | 主機磁碟區掛載      | 保留 QR 登入               |
| Gmail 金鑰圈       | `/home/node/.openclaw/`           | 主機磁碟區 + 密碼 | 需要 `GOG_KEYRING_PASSWORD`  |
| 外部二進位檔案   | `/usr/local/bin/`                 | Docker 映像檔          | 必須在建置時烘焙              |
| Node 執行環境        | 容器檔案系統             | Docker 映像檔          | 每次映像檔建置時都會重建        |
| 作業系統套件         | 容器檔案系統             | Docker 映像檔          | 請勿在運行時安裝              |
| Docker 容器    | 暫時性的                  | 可重啟             | 可安全銷毀                  |

---

## 更新

若要更新虛擬機器上的 OpenClaw：

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## 疑難排解

**SSH 連線被拒絕**

SSH 金鑰傳播可能在虛擬機器建立後需要 1-2 分鐘。請稍候再試。

**作業系統登入問題**

檢查您的作業系統登入設定檔：

```bash
gcloud compute os-login describe-profile
```

確保您的帳號具有所需的 IAM 權限 (Compute OS Login 或 Compute OS Admin Login)。

**記憶體不足 (OOM)**

如果使用 e2-micro 並遇到記憶體不足，請升級到 e2-small 或 e2-medium：

```bash
# 首先停止虛擬機器
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# 變更機器類型
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# 啟動虛擬機器
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## 服務帳號 (安全最佳實務)

對於個人使用，您的預設使用者帳號運作良好。

對於自動化或 CI/CD 管道，請建立具有最少權限的專用服務帳號：

1. 建立服務帳號：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. 授予 Compute Instance Admin 角色 (或更窄的自訂角色)：

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy @my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

避免為自動化使用 Owner 角色。請使用最小權限原則。

有關 IAM 角色詳細資訊，請參閱 [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)。

---

## 後續步驟

- 設定訊息頻道：[頻道](/channels)
- 將本地裝置配對為節點：[節點](/nodes)
- 設定 Gateway：[Gateway 設定](/gateway/configuration)
