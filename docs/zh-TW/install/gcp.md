---
summary: >-
  Run OpenClaw Gateway 24/7 on a GCP Compute Engine VM (Docker) with durable
  state
read_when:
  - You want OpenClaw running 24/7 on GCP
  - "You want a production-grade, always-on Gateway on your own VM"
  - "You want full control over persistence, binaries, and restart behavior"
title: GCP
---

# 在 GCP Compute Engine 上執行 OpenClaw（Docker，生產 VPS 指南）

## 目標

在 GCP Compute Engine VM 上使用 Docker 執行持久性的 OpenClaw Gateway，具備耐久狀態、內建二進位檔及安全重啟行為。

如果你想要「OpenClaw 24/7，月費約 $5-12 美元」，這是在 Google Cloud 上可靠的設定方式。
價格會依機器類型和區域有所不同；選擇符合你工作負載的最小 VM，若遇到記憶體不足（OOM）再升級。

## 我們在做什麼（簡單說明）？

- 建立 GCP 專案並啟用計費
- 建立 Compute Engine VM
- 安裝 Docker（隔離的應用執行環境）
- 在 Docker 中啟動 OpenClaw Gateway
- 在主機上持久化 `~/.openclaw` 和 `~/.openclaw/workspace`（可存活重啟/重建）
- 透過 SSH 隧道從筆電存取控制介面

Gateway 可透過以下方式存取：

- 從筆電透過 SSH 端口轉發
- 若自行管理防火牆和 token，則可直接開放端口

本指南使用 GCP Compute Engine 上的 Debian。
Ubuntu 也適用，請對應套件名稱。
關於通用 Docker 流程，請參考 [Docker](/install/docker)。

---

## 快速路徑（有經驗的操作員）

1. 建立 GCP 專案並啟用 Compute Engine API
2. 建立 Compute Engine VM（e2-small，Debian 12，20GB）
3. SSH 登入 VM
4. 安裝 Docker
5. 克隆 OpenClaw 倉庫
6. 建立持久化主機目錄
7. 設定 `.env` 和 `docker-compose.yml`
8. 內建所需二進位檔，建置並啟動

---

## 你需要準備

- GCP 帳號（e2-micro 可使用免費額度）
- 安裝 gcloud CLI（或使用 Cloud Console）
- 從筆電有 SSH 存取權限
- 基本 SSH 與複製貼上操作能力
- 約 20-30 分鐘時間
- Docker 與 Docker Compose
- 模型授權憑證
- 選用的服務提供者憑證
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1) 安裝 gcloud CLI（或使用 Console）

**選項 A：gcloud CLI**（建議用於自動化）

從 [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) 安裝

初始化並進行身份驗證：

```bash
gcloud init
gcloud auth login
```

**選項 B：Cloud Console**

所有步驟皆可透過網頁介面於 [https://console.cloud.google.com](https://console.cloud.google.com) 完成

---

## 2) 建立 GCP 專案

**CLI：**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

於 [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) 啟用計費（Compute Engine 必須）。

啟用 Compute Engine API：

```bash
gcloud services enable compute.googleapis.com
```

**主控台：**

1. 前往 IAM 與管理員 > 建立專案
2. 命名並建立專案
3. 啟用專案的計費功能
4. 前往 API 與服務 > 啟用 API > 搜尋「Compute Engine API」> 啟用

---

## 3) 建立虛擬機器 (VM)

**機器類型：**

| 類型      | 規格                    | 費用         | 備註                                             |
| --------- | ----------------------- | ------------ | ------------------------------------------------ |
| e2-medium | 2 vCPU, 4GB RAM         | 約 $25/月    | 本地 Docker 建置最穩定的選擇                     |
| e2-small  | 2 vCPU, 2GB RAM         | 約 $12/月    | Docker 建置的最低建議規格                        |
| e2-micro  | 2 vCPU（共享）、1GB RAM | 免費方案適用 | Docker 建置常因記憶體不足（OOM，退出碼 137）失敗 |

**CLI：**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**主控台：**

1. 前往 Compute Engine > VM 實例 > 建立實例
2. 名稱：`openclaw-gateway`
3. 區域：`us-central1`，區域分區：`us-central1-a`
4. 機器類型：`e2-small`
5. 開機磁碟：Debian 12，20GB
6. 建立

---

## 4) SSH 連線至 VM

**CLI：**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**主控台：**

點擊 Compute Engine 控制台中您虛擬機旁的「SSH」按鈕。

注意：SSH 金鑰傳播可能需要 1-2 分鐘，若連線被拒絕，請稍候再試。

---

## 5) 在虛擬機上安裝 Docker

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

接著重新使用 SSH 連線：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

確認安裝：

```bash
docker --version
docker compose version
```

---

## 6) 複製 OpenClaw 倉庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設您會建立自訂映像，以確保二進位檔持久存在。

---

## 7) 建立持久化主機目錄

Docker 容器是短暫性的。
所有長期存在的狀態必須保存在主機上。

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) 設定環境變數

在專案根目錄建立 `.env`。

bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw

產生強密碼：

```bash
openssl rand -hex 32
```

**請勿將此檔案提交至版本控制。**

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
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

## 10) 將所需的二進位檔燒錄進映像檔（關鍵）

在執行中的容器內安裝二進位檔是陷阱。
任何在執行時安裝的東西，重啟後都會遺失。

所有技能所需的外部二進位檔必須在映像檔建置時安裝。

以下範例只展示三個常見的二進位檔：

- `gog` 用於 Gmail 存取
- `goplaces` 用於 Google Places
- `wacli` 用於 WhatsApp

這些只是範例，並非完整清單。
你可以用相同的模式安裝任意數量的二進位檔。

如果日後新增依賴其他二進位檔的技能，必須：

1. 更新 Dockerfile
2. 重新建置映像檔
3. 重新啟動容器

**Dockerfile 範例**

dockerfile
FROM node:24-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/\*

# 範例二進位檔 1：Gmail CLI

RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
 | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 範例二進位檔 2：Google Places CLI

RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
 | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 範例二進位檔 3：WhatsApp CLI

RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
 | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 以下可用相同模式新增更多二進位檔

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

---

## 11) 建置與啟動

```bash
docker compose build
docker compose up -d openclaw-gateway
```

如果在 `pnpm install --frozen-lockfile` 過程中建置失敗並出現 `Killed` / `exit code 137`，表示虛擬機記憶體不足。請使用至少 `e2-small`，或使用 `e2-medium` 以獲得更穩定的首次建置。

當綁定到區域網路 (LAN) (`OPENCLAW_GATEWAY_BIND=lan`) 時，請先設定受信任的瀏覽器來源，然後再繼續：

```bash
docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
```

如果您更改了閘道埠，請將 `18789` 替換為您設定的埠號。

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

## 12) 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) 從您的筆電存取

建立 SSH 隧道以轉發 Gateway 連接埠：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

在瀏覽器中開啟：

`http://127.0.0.1:18789/`

取得一個新的帶有 token 的儀表板連結：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
```

貼上該 URL 中的 token。

如果 Control UI 顯示 `unauthorized` 或 `disconnected (1008): pairing required`，請批准瀏覽器裝置：

```bash
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

---

## 各項資料的持久化位置（真實資料來源）

OpenClaw 在 Docker 中執行，但 Docker 並非真實資料來源。
所有長期存在的狀態必須能夠在重啟、重建和重新開機後持續保存。

| 元件           | 位置                              | 持久化機制        | 備註                        |
| -------------- | --------------------------------- | ----------------- | --------------------------- |
| Gateway 設定   | `/home/node/.openclaw/`           | 主機掛載卷        | 包含 `openclaw.json`、token |
| 模型授權設定檔 | `/home/node/.openclaw/`           | 主機掛載卷        | OAuth token、API 金鑰       |
| Skill 設定     | `/home/node/.openclaw/skills/`    | 主機掛載卷        | Skill 級別狀態              |
| Agent 工作區   | `/home/node/.openclaw/workspace/` | 主機掛載卷        | 程式碼與 agent 產物         |
| WhatsApp 會話  | `/home/node/.openclaw/`           | 主機掛載卷        | 保留 QR 登入                |
| Gmail 金鑰環   | `/home/node/.openclaw/`           | 主機掛載卷 + 密碼 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二進位檔   | `/usr/local/bin/`                 | Docker 映像檔     | 必須在建置時加入            |
| Node 執行環境  | 容器檔案系統                      | Docker 映像檔     | 每次映像檔建置時重建        |
| 作業系統套件   | 容器檔案系統                      | Docker 映像檔     | 不可在執行時安裝            |
| Docker 容器    | 臨時性                            | 可重啟            | 可安全銷毀                  |

---

## 更新

在虛擬機上更新 OpenClaw：

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## 疑難排解

**SSH 連線被拒絕**

SSH 金鑰傳播在 VM 建立後可能需要 1-2 分鐘。請稍待並重試。

**OS Login 問題**

請檢查您的 OS Login 設定：

```bash
gcloud compute os-login describe-profile
```

確保您的帳號擁有必要的 IAM 權限（Compute OS Login 或 Compute OS Admin Login）。

**記憶體不足 (OOM)**

如果 Docker build 失敗並出現 `Killed` 和 `exit code 137`，表示 VM 因記憶體不足被系統終止。請升級至 e2-small（最低需求）或 e2-medium（建議用於穩定的本地建置）：

bash

# 先停止 VM

gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# 變更機器類型

gcloud compute instances set-machine-type openclaw-gateway \
 --zone=us-central1-a \
 --machine-type=e2-small

# 啟動 VM

gcloud compute instances start openclaw-gateway --zone=us-central1-a

---

## 服務帳號（安全最佳實踐）

個人使用時，預設使用者帳號即可。

自動化或 CI/CD 流程，請建立具備最小權限的專用服務帳號：

1. 建立服務帳號：

```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
```

2. 授予 Compute Instance Admin 角色（或更有限的自訂角色）：

```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
```

避免在自動化中使用 Owner 角色。請遵循最小權限原則。

詳細 IAM 角色資訊請參考 [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)。

---

## 下一步

- 設定訊息通道：[Channels](/channels)
- 將本地裝置配對為節點：[Nodes](/nodes)
- 設定 Gateway：[Gateway configuration](/gateway/configuration)
