---
summary: >-
  Run OpenClaw Gateway 24/7 on a cheap Hetzner VPS (Docker) with durable state
  and baked-in binaries
read_when:
  - You want OpenClaw running 24/7 on a cloud VPS (not your laptop)
  - "You want a production-grade, always-on Gateway on your own VPS"
  - "You want full control over persistence, binaries, and restart behavior"
  - You are running OpenClaw in Docker on Hetzner or a similar provider
title: Hetzner
---

# OpenClaw 在 Hetzner 上部署（Docker，生產環境 VPS 指南）

## 目標

在 Hetzner VPS 上使用 Docker 執行持久化的 OpenClaw Gateway，具備耐久狀態、內建二進位檔及安全重啟行為。

如果你想要「OpenClaw 24/7，大約 5 美元」，這是最簡單且可靠的設定方式。  
Hetzner 價格會變動；選擇最小的 Debian/Ubuntu VPS，若遇到記憶體不足（OOM）再升級。

安全模型提醒：

- 公司共用代理在所有人都屬於同一信任邊界且執行環境僅限商業用途時是可行的。
- 嚴格分離：專用 VPS/執行環境 + 專用帳號；該主機上不使用個人 Apple/Google/瀏覽器/密碼管理器設定檔。
- 若使用者彼此為對立關係，請依 Gateway/主機/作業系統使用者分割。

詳見 [安全](/gateway/security) 與 [VPS 主機](/vps)。

## 我們在做什麼（簡單說明）？

- 租用一台小型 Linux 伺服器（Hetzner VPS）
- 安裝 Docker（隔離的應用執行環境）
- 在 Docker 中啟動 OpenClaw Gateway
- 在主機上持久化 `~/.openclaw` 與 `~/.openclaw/workspace`（可存活重啟與重建）
- 從筆電透過 SSH 隧道存取控制介面

Gateway 可透過以下方式存取：

- 從筆電使用 SSH 端口轉發
- 若自行管理防火牆與 token，則可直接開放端口

本指南假設使用 Hetzner 上的 Ubuntu 或 Debian。  
若使用其他 Linux VPS，請對應套件名稱。  
關於通用 Docker 流程，請參考 [Docker](/install/docker)。

---

## 快速路徑（有經驗的操作員）

1. 建立 Hetzner VPS
2. 安裝 Docker
3. 複製 OpenClaw 程式庫
4. 建立持久化主機目錄
5. 設定 `.env` 與 `docker-compose.yml`
6. 將所需二進位檔烘焙進映像檔
7. `docker compose up -d`
8. 驗證持久化與 Gateway 存取

---

## 你需要準備的專案

- 具有 root 權限的 Hetzner VPS
- 從你的筆電進行 SSH 連線
- 基本的 SSH 使用與複製貼上能力
- 約 20 分鐘時間
- Docker 與 Docker Compose
- 模型授權憑證
- 選用的服務提供者憑證
  - WhatsApp QR
  - Telegram 機器人 token
  - Gmail OAuth

---

## 1) 設定 VPS

在 Hetzner 建立一台 Ubuntu 或 Debian VPS。

以 root 身份連線：

```bash
ssh root@YOUR_VPS_IP
```

本指南假設 VPS 是有狀態的。
請勿將其視為可丟棄的基礎架構。

---

## 2) 安裝 Docker（在 VPS 上）

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

確認安裝：

```bash
docker --version
docker compose version
```

---

## 3) 複製 OpenClaw 倉庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設您將建立自訂映像，以確保二進位檔持久化。

---

## 4) 建立持久化主機目錄

Docker 容器是短暫性的。
所有長期存在的狀態必須存放在主機上。

bash
mkdir -p /root/.openclaw/workspace

# 將擁有權設定為容器使用者（uid 1000）：

chown -R 1000:1000 /root/.openclaw

---

## 5) 設定環境變數

在倉庫根目錄建立 `.env`。

bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw

產生強密碼：

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
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
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` 僅為啟動便利所設，並非取代正式的閘道器設定。仍需設定認證（`gateway.auth.token` 或密碼）並使用安全的綁定設定來部署。

---

## 7) 將必要的二進位檔燒錄進映像檔（關鍵）

在執行中的容器內安裝二進位檔是陷阱。
任何在執行時安裝的東西，重啟後都會遺失。

所有技能所需的外部二進位檔必須在映像檔建置時安裝。

以下範例只展示三個常見的二進位檔：

- 用於 Gmail 存取的 `gog`
- 用於 Google Places 的 `goplaces`
- 用於 WhatsApp 的 `wacli`

這些只是範例，並非完整清單。
你可以用相同的模式安裝任意數量的二進位檔。

如果你之後新增依賴其他二進位檔的技能，必須：

1. 更新 Dockerfile
2. 重新建置映像檔
3. 重新啟動容器

**範例 Dockerfile**

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

## 8) 建置並啟動

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

## 9) 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

從你的筆電：

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

打開：

`http://127.0.0.1:18789/`

貼上你的 gateway token。

---

## 資料持久化位置（真實資料來源）

OpenClaw 執行於 Docker 中，但 Docker 並非真實資料來源。  
所有長期存在的狀態必須能夠在重啟、重建和重新開機後持續保存。

| 元件           | 位置                              | 持久化機制        | 備註                        |
| -------------- | --------------------------------- | ----------------- | --------------------------- |
| Gateway 設定   | `/home/node/.openclaw/`           | 主機掛載卷        | 包含 `openclaw.json`、token |
| 模型授權設定檔 | `/home/node/.openclaw/`           | 主機掛載卷        | OAuth token、API 金鑰       |
| Skill 設定     | `/home/node/.openclaw/skills/`    | 主機掛載卷        | Skill 級別狀態              |
| Agent 工作區   | `/home/node/.openclaw/workspace/` | 主機掛載卷        | 程式碼與 agent 產物         |
| WhatsApp 會話  | `/home/node/.openclaw/`           | 主機掛載卷        | 保留 QR 登入                |
| Gmail 金鑰環   | `/home/node/.openclaw/`           | 主機掛載卷 + 密碼 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二進位檔   | `/usr/local/bin/`                 | Docker 映像檔     | 必須在建置時內建            |
| Node 執行環境  | 容器檔案系統                      | Docker 映像檔     | 每次映像建置時重建          |
| 作業系統套件   | 容器檔案系統                      | Docker 映像檔     | 不可在執行時安裝            |
| Docker 容器    | 臨時性                            | 可重啟            | 可安全銷毀                  |

---

## 基礎架構即程式碼（Terraform）

對於偏好基礎架構即程式碼工作流程的團隊，社群維護的 Terraform 設定提供：

- 模組化 Terraform 設定與遠端狀態管理
- 透過 cloud-init 自動化佈署
- 部署腳本（引導、部署、備份/還原）
- 安全強化（防火牆、UFW、僅限 SSH 存取）
- Gateway 存取的 SSH 隧道設定

**程式碼庫：**

- 基礎架構：[openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker 設定：[openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

此方案補足上述 Docker 設定，提供可重現的佈署、版本控管的基礎架構，以及自動化的災難復原。

> **注意：** 社群維護。若有問題或想貢獻，請參考上述程式碼庫連結。
