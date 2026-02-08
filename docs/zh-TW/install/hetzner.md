---
summary: 「在價格實惠的 Hetzner VPS（Docker）上 24/7 執行 OpenClaw Gateway 閘道器，具備可持久狀態與內建二進位檔」
read_when:
  - 「你想在雲端 VPS（而非你的筆電）上 24/7 執行 OpenClaw」
  - 「你想在自己的 VPS 上部署生產等級、永遠在線的 Gateway 閘道器」
  - 「你想完全掌控持久化、二進位檔與重新啟動行為」
  - 「你正在 Hetzner 或類似供應商上以 Docker 執行 OpenClaw」
title: 「Hetzner」
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:33Z
---

# Hetzner 上的 OpenClaw（Docker，生產 VPS 指南）

## 目標

使用 Docker 在 Hetzner VPS 上執行具備持久狀態、內建二進位檔，且可安全重新啟動的 OpenClaw Gateway 閘道器。

如果你想要「約 ~$5 的 OpenClaw 24/7」，這是最簡單且可靠的設定。
Hetzner 的價格可能會變動；請選擇最小的 Debian／Ubuntu VPS，若遇到 OOM 再升級。

## 我們在做什麼（白話說明）？

- 租用一台小型 Linux 伺服器（Hetzner VPS）
- 安裝 Docker（隔離的應用程式執行環境）
- 在 Docker 中啟動 OpenClaw Gateway 閘道器
- 在主機上持久化 `~/.openclaw` + `~/.openclaw/workspace`（可跨重新啟動／重建存活）
- 透過 SSH 通道，從你的筆電存取控制 UI

Gateway 閘道器可透過以下方式存取：

- 從你的筆電進行 SSH 連接埠轉送
- 若你自行管理防火牆與權杖，則可直接開放連接埠

本指南假設你在 Hetzner 上使用 Ubuntu 或 Debian。  
若你使用其他 Linux VPS，請對應調整套件。
若要查看通用的 Docker 流程，請參閱 [Docker](/install/docker)。

---

## 快速路徑（有經驗的操作人員）

1. 建立 Hetzner VPS
2. 安裝 Docker
3. 複製 OpenClaw 儲存庫
4. 建立持久化的主機目錄
5. 設定 `.env` 與 `docker-compose.yml`
6. 將必要的二進位檔烘焙進映像檔
7. `docker compose up -d`
8. 驗證持久化與 Gateway 閘道器存取

---

## 你需要準備的項目

- 具備 root 存取權的 Hetzner VPS
- 從你的筆電進行 SSH 連線
- 基本的 SSH + 複製／貼上操作熟悉度
- 約 20 分鐘
- Docker 與 Docker Compose
- 模型身分驗證憑證
- 選用的提供者憑證
  - WhatsApp QR
  - Telegram 機器人權杖
  - Gmail OAuth

---

## 1) 建立 VPS

在 Hetzner 建立一台 Ubuntu 或 Debian VPS。

以 root 連線：

```bash
ssh root@YOUR_VPS_IP
```

本指南假設該 VPS 是有狀態的。
請勿將其視為可隨意丟棄的基礎設施。

---

## 2) 在 VPS 上安裝 Docker

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

本指南假設你會建置自訂映像檔，以確保二進位檔的持久性。

---

## 4) 建立持久化的主機目錄

Docker 容器是短暫的。
所有長期存在的狀態都必須放在主機上。

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) 設定環境變數

在儲存庫根目錄建立 `.env`。

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

產生強式祕密：

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

## 7) 將必要的二進位檔烘焙進映像檔（關鍵）

在執行中的容器內安裝二進位檔是一個陷阱。
任何在執行期安裝的內容，都會在重新啟動時遺失。

Skills 所需的所有外部二進位檔，都必須在映像檔建置時安裝。

以下範例僅示範三種常見的二進位檔：

- 用於 Gmail 存取的 `gog`
- 用於 Google Places 的 `goplaces`
- 用於 WhatsApp 的 `wacli`

這些只是範例，並非完整清單。
你可以使用相同的模式安裝任意數量的二進位檔。

若你之後新增依賴其他二進位檔的 Skills，必須：

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

## 9) 驗證 Gateway 閘道器

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

在你的筆電上：

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

開啟：

`http://127.0.0.1:18789/`

貼上你的 Gateway 閘道器權杖。

---

## 各項內容的持久化位置（事實來源）

OpenClaw 在 Docker 中執行，但 Docker 不是事實來源。
所有長期存在的狀態，都必須能在重新啟動、重建與重新開機後存活。

| 元件               | 位置                              | 持久化機制         | 備註                        |
| ------------------ | --------------------------------- | ------------------ | --------------------------- |
| Gateway 設定       | `/home/node/.openclaw/`           | 主機 Volume 掛載   | 包含 `openclaw.json`、權杖  |
| 模型身分驗證設定檔 | `/home/node/.openclaw/`           | 主機 Volume 掛載   | OAuth 權杖、API 金鑰        |
| Skill 設定         | `/home/node/.openclaw/skills/`    | 主機 Volume 掛載   | Skill 層級狀態              |
| 代理程式工作區     | `/home/node/.openclaw/workspace/` | 主機 Volume 掛載   | 程式碼與代理程式成品        |
| WhatsApp 工作階段  | `/home/node/.openclaw/`           | 主機 Volume 掛載   | 保留 QR 登入狀態            |
| Gmail 金鑰圈       | `/home/node/.openclaw/`           | 主機 Volume + 密碼 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二進位檔       | `/usr/local/bin/`                 | Docker 映像檔      | 必須在建置時烘焙            |
| Node 執行環境      | 容器檔案系統                      | Docker 映像檔      | 每次映像檔建置都會重建      |
| OS 套件            | 容器檔案系統                      | Docker 映像檔      | 請勿在執行期安裝            |
| Docker 容器        | 短暫                              | 可重新啟動         | 可安全銷毀                  |
