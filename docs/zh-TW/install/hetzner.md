---
summary: "在便宜的 Hetzner VPS (Docker) 上 24 小時不間斷執行 OpenClaw Gateway，並具備持久化狀態與內建的二進位檔案"
read_when:
  - 你想在雲端 VPS（而非你的筆記型電腦）上 24 小時不間斷執行 OpenClaw
  - 你想在自己的 VPS 上建立生產等級、永不離線的 Gateway
  - 你想完全控制持久化、二進位檔案和重啟行為
  - 你正在 Hetzner 或類似的供應商上透過 Docker 執行 OpenClaw
title: "Hetzner"
---

# 在 Hetzner 上執行 OpenClaw (Docker, 生產環境 VPS 指南)

## 目標

使用 Docker 在 Hetzner VPS 上執行持久化的 OpenClaw Gateway，並具備持久化狀態、內建的二進位檔案以及安全的重啟行為。

如果你想「以每月約 5 美元的成本 24 小時不間斷執行 OpenClaw」，這是最簡單可靠的設定方式。
Hetzner 的價格會變動；請選擇最小的 Debian/Ubuntu VPS，如果遇到記憶體不足 (OOM) 再向上擴展。

## 我們要實作什麼（簡單來說）？

- 租用一台小型 Linux 伺服器 (Hetzner VPS)
- 安裝 Docker（隔離的應用程式執行環境）
- 在 Docker 中啟動 OpenClaw Gateway
- 在宿主機上持久化 `~/.openclaw` + `~/.openclaw/workspace`（在重啟/重新建置後仍能保留）
- 透過 SSH 通道從你的筆記型電腦存取控制介面

Gateway 可以透過以下方式存取：

- 從你的筆記型電腦進行 SSH 連接埠轉發
- 如果你自行管理防火牆和憑證，則可以直接公開連接埠

本指南假設在 Hetzner 上使用 Ubuntu 或 Debian。  
如果你使用其他的 Linux VPS，請對應調整套件。
關於通用的 Docker 流程，請參閱 [Docker](/install/docker)。

---

## 快速路徑（給有經驗的操作者）

1. 建置 Hetzner VPS
2. 安裝 Docker
3. 複製 OpenClaw 儲存庫
4. 建立持久化的宿主機目錄
5. 設定 `.env` 和 `docker-compose.yml`
6. 將所需的二進位檔案建置進映像檔中
7. `docker compose up -d`
8. 驗證持久化和 Gateway 存取

---

## 準備工作

- 具備 root 權限的 Hetzner VPS
- 從筆記型電腦存取 SSH
- 熟悉基本的 SSH 操作與複製貼上
- 約 20 分鐘
- Docker 和 Docker Compose
- 模型認證憑證
- 可選的供應商憑證
  - WhatsApp QR 碼
  - Telegram 機器人權杖 (Bot token)
  - Gmail OAuth

---

## 1) 建置 VPS

在 Hetzner 中建立一個 Ubuntu 或 Debian VPS。

以 root 身分連線：

```bash
ssh root @YOUR_VPS_IP
```

本指南假設此 VPS 是有狀態的。
請勿將其視為可丟棄的基礎設施。

---

## 2) 安裝 Docker（在 VPS 上）

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

驗證：

```bash
docker --version
docker compose version
```

---

## 3) 複製 OpenClaw 儲存庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設你將建置自訂映像檔以確保二進位檔案的持久性。

---

## 4) 建立持久化的宿主機目錄

Docker 容器是暫時性的。
所有長期存在的狀態都必須儲存在宿主機上。

```bash
mkdir -p /root/.openclaw/workspace

# 將所有權設定給容器使用者 (uid 1000)：
chown -R 1000:1000 /root/.openclaw
```

---

## 5) 設定環境變數

在儲存庫根目錄建立 `.env` 檔案。

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

產生強密鑰：

```bash
openssl rand -hex 32
```

**請勿提交此檔案。**

---

## 6) Docker Compose 設定

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
      # 建議：在 VPS 上讓 Gateway 僅限 local loopback；透過 SSH 通道存取。
      # 若要公開存取，請移除 `127.0.0.1:` 前綴並對應設定防火牆。
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # 可選：僅當你在此 VPS 上執行 iOS/Android 節點並需要 Canvas 宿主機時使用。
      # 如果你公開此連接埠，請閱讀 /gateway/security 並對應設定防火牆。
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
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` 僅用於方便初步啟動，它不能替代正確的 Gateway 設定。仍請設定認證（`gateway.auth.token` 或密碼）並為你的部署使用安全的綁定 (bind) 設定。

---

## 7) 將所需的二進位檔案建置進映像檔中（關鍵）

在執行中的容器內安裝二進位檔案是一個陷阱。
任何在執行時安裝的內容都會在重啟後消失。

Skills 所需的所有外部二進位檔案都必須在映像檔建置時安裝。

下面的範例僅顯示三個常見的二進位檔案：

- `gog` 用於 Gmail 存取
- `goplaces` 用於 Google Places
- `wacli` 用於 WhatsApp

這些只是範例，並非完整清單。
你可以使用相同的模式安裝所需的任何二進位檔案。

如果你之後新增了依賴額外二進位檔案的 Skills，你必須：

1. 更新 Dockerfile
2. 重新建置映像檔
3. 重啟容器

**Dockerfile 範例**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# 範例二進位檔案 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 範例二進位檔案 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 範例二進位檔案 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 使用相同模式在下方新增更多二進位檔案

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

## 8) 建置並啟動

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

## 9) 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

從你的筆記型電腦：

```bash
ssh -N -L 18789:127.0.0.1:18789 root @YOUR_VPS_IP
```

開啟：

`http://127.0.0.1:18789/`

貼上你的 Gateway 權杖 (token)。

---

## 什麼東西會持久化到哪裡（資料來源）

OpenClaw 雖然在 Docker 中執行，但 Docker 並非資料真實來源 (Source of Truth)。所有長期存在的狀態都必須在重啟、重新建置和開機後保留。

| 元件              | 位置                              | 持久化機制          | 備註                        |
| ----------------- | --------------------------------- | ------------------- | --------------------------- |
| Gateway 設定      | `/home/node/.openclaw/`           | 宿主機磁碟卷掛載    | 包含 `openclaw.json`、權杖  |
| 模型認證設定檔    | `/home/node/.openclaw/`           | 宿主機磁碟卷掛載    | OAuth 權杖、API 金鑰        |
| Skill 設定        | `/home/node/.openclaw/skills/`    | 宿主機磁碟卷掛載    | Skill 等級的狀態            |
| 智慧代理工作區    | `/home/node/.openclaw/workspace/` | 宿主機磁碟卷掛載    | 程式碼與智慧代理產物        |
| WhatsApp 工作階段 | `/home/node/.openclaw/`           | 宿主機磁碟卷掛載    | 保留 QR 碼登入狀態          |
| Gmail 鑰匙圈      | `/home/node/.openclaw/`           | 宿主機磁碟卷 + 密碼 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二進位檔案    | `/usr/local/bin/`                 | Docker 映像檔       | 必須在建置時內建            |
| Node 執行環境     | 容器檔案系統                      | Docker 映像檔       | 每次映像檔建置時重新建置    |
| 作業系統套件      | 容器檔案系統                      | Docker 映像檔       | 請勿在執行時安裝            |
| Docker 容器       | 暫時性                            | 可重啟              | 可以安全地銷毀              |

---

## 基礎設施即程式碼 (Terraform)

對於偏好基礎設施即程式碼 (IaC) 工作流的團隊，社群維護的 Terraform 設定提供了：

- 具備遠端狀態管理的模組化 Terraform 設定
- 透過 cloud-init 自動建置
- 部署腳本（啟動、部署、備份/還原）
- 安全性強化（防火牆、UFW、僅限 SSH 存取）
- 用於 Gateway 存取的 SSH 通道設定

**儲存庫：**

- 基礎設施：[openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker 設定：[openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

這種方法透過可重現的部署、版本控制的基礎設施以及自動化的災難復原，補充了上述的 Docker 設定。

> **注意：** 由社群維護。如需回報問題或進行貢獻，請參見上方的儲存庫連結。
