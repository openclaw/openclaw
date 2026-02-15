---
summary: "在便宜的 Hetzner VPS (Docker) 上以持久狀態和內建二進位檔 24/7 執行 OpenClaw Gateway"
read_when:
  - 您想讓 OpenClaw 在雲端 VPS (而非您的筆電) 上 24/7 執行
  - 您想要在自己的 VPS 上部署一個生產級、永遠在線的 Gateway
  - 您想要完全控制持久性、二進位檔和重啟行為
  - 您正在 Hetzner 或類似供應商的 Docker 上執行 OpenClaw
title: "Hetzner"
---

# 在 Hetzner 上執行 OpenClaw (Docker, 生產環境 VPS 指南)

## 目標

在 Hetzner VPS 上使用 Docker 執行一個持久的 OpenClaw Gateway，具備持久狀態、內建二進位檔和安全的重啟行為。

如果您想要「OpenClaw 24/7 只需約 $5」，這是最簡單可靠的設定。
Hetzner 的定價會變動；請選擇最小的 Debian/Ubuntu VPS，如果遇到記憶體不足 (OOM) 再升級。

## 我們正在做什麼 (簡單來說)？

- 租用一台小型 Linux 伺服器 (Hetzner VPS)
- 安裝 Docker (隔離的應用程式執行環境)
- 在 Docker 中啟動 OpenClaw Gateway
- 將 `~/.openclaw` + `~/.openclaw/workspace` 持久化到主機上 (在重啟/重建後仍能保留)
- 透過 SSH 通道從您的筆電存取 Control UI

Gateway 可以透過以下方式存取：

- 從您的筆電進行 SSH 通訊埠轉發
- 如果您自行管理防火牆和權杖，則可直接暴露通訊埠

本指南假設您在 Hetzner 上使用 Ubuntu 或 Debian。
如果您使用其他 Linux VPS，請相應地對應套件。
有關通用 Docker 流程，請參閱 [Docker](/install/docker)。

---

## 快速路徑 (經驗豐富的操作員)

1. 配置 Hetzner VPS
2. 安裝 Docker
3. 克隆 OpenClaw 儲存庫
4. 建立持久的主機目錄
5. 設定 `.env` 和 `docker-compose.yml`
6. 將必要的二進位檔烘焙到映像檔中
7. `docker compose up -d`
8. 驗證持久性和 Gateway 存取

---

## 您需要什麼

- 具備 root 存取權的 Hetzner VPS
- 從您的筆電進行 SSH 存取
- 基本的 SSH + 複製/貼上操作舒適度
- 約 20 分鐘
- Docker 和 Docker Compose
- 模型驗證憑證
- 可選的供應商憑證
  - WhatsApp QR
  - Telegram bot 權杖
  - Gmail OAuth

---

## 1) 配置 VPS

在 Hetzner 中建立一個 Ubuntu 或 Debian VPS。

以 root 身分連線：

```bash
ssh root @YOUR_VPS_IP
```

本指南假設 VPS 是有狀態的。
請勿將其視為一次性基礎設施。

---

## 2) 安裝 Docker (在 VPS 上)

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

## 3) 克隆 OpenClaw 儲存庫

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假設您將建立一個自訂映像檔以保證二進位檔的持久性。

---

## 4) 建立持久的主機目錄

Docker 容器是短暫的。
所有長期存在的狀態都必須位於主機上。

```bash
mkdir -p /root/.openclaw/workspace

# 將所有權設定為容器使用者 (uid 1000)：
chown -R 1000:1000 /root/.openclaw
```

---

## 5) 設定環境變數

在儲存庫根目錄中建立 `.env` 檔案。

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
      # 建議：保持 Gateway 在 VPS 上僅限 local loopback；透過 SSH 通道存取。
      # 若要公開暴露，請移除 `127.0.0.1:` 前綴並相應地設定防火牆。
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # 可選：僅當您針對此 VPS 執行 iOS/Android 節點並需要 Canvas 主機時。
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
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` 僅用於啟動便利性，它不能替代正確的 Gateway 設定。仍然要設定驗證 (`gateway.auth.token` 或密碼) 並為您的部署使用安全的綁定設定。

---

## 7) 將所需的二進位檔烘焙到映像檔中 (關鍵)

在執行中的容器內安裝二進位檔是一個陷阱。
任何在執行時安裝的內容都會在重啟時丟失。

所有技能所需的外部二進位檔必須在映像檔建置時安裝。

以下範例僅顯示三個常見的二進位檔：

- `gog` 用於 Gmail 存取
- `goplaces` 用於 Google Places
- `wacli` 用於 WhatsApp

這些是範例，不是完整列表。
您可以使用相同的模式安裝任意數量的二進位檔。

如果您稍後添加依賴於其他二進位檔的新技能，您必須：

1. 更新 Dockerfile
2. 重建映像檔
3. 重啟容器

**Dockerfile 範例**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# 範例二進位檔 1：Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 範例二進位檔 2：Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 範例二進位檔 3：WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 使用相同的模式在下方添加更多二進位檔

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

## 9) 驗證 Gateway

```bash
docker compose logs -f openclaw-gateway
```

成功：

```
[gateway] listening on ws://0.0.0.0:18789
```

從您的筆電：

```bash
ssh -N -L 18789:127.0.0.1:18789 root @YOUR_VPS_IP
```

打開：

`http://127.0.0.1:18789/`

貼上您的 Gateway 權杖。

---

## 哪些內容會持久化 (真實來源)

OpenClaw 在 Docker 中執行，但 Docker 不是真實來源。
所有長期存在的狀態都必須在重啟、重建和重新啟動後仍能保留。

| 元件           | 位置                              | 持久化機制            | 備註                          |
| -------------- | --------------------------------- | --------------------- | ----------------------------- |
| Gateway 設定   | `/home/node/.openclaw/`           | 主機磁碟區掛載        | 包含 `openclaw.json`、權杖     |
| 模型驗證檔案   | `/home/node/.openclaw/`           | 主機磁碟區掛載        | OAuth 權杖、API 金鑰          |
| Skill 設定     | `/home/node/.openclaw/skills/`    | 主機磁碟區掛載        | Skill 層級的狀態              |
| 智慧代理工作區 | `/home/node/.openclaw/workspace/` | 主機磁碟區掛載        | 程式碼和智慧代理產物          |
| WhatsApp 工作階段 | `/home/node/.openclaw/`           | 主機磁碟區掛載        | 保留 QR 登入                  |
| Gmail 金鑰圈   | `/home/node/.openclaw/`           | 主機磁碟區 + 密碼     | 需要 `GOG_KEYRING_PASSWORD`   |
| 外部二進位檔   | `/usr/local/bin/`                 | Docker 映像檔         | 必須在建置時烘焙             |
| Node 執行環境  | 容器檔案系統                      | Docker 映像檔         | 每次映像檔建置時都會重建      |
| 作業系統套件   | 容器檔案系統                      | Docker 映像檔         | 請勿在執行時安裝              |
| Docker 容器    | 短暫的                          | 可重啟的              | 可安全銷毀                  |

---

## 基礎設施即程式碼 (Terraform)

對於偏好基礎設施即程式碼工作流程的團隊，社群維護的 Terraform 設定提供了：

- 帶有遠端狀態管理的模組化 Terraform 設定
- 透過 cloud-init 自動配置
- 部署腳本 (啟動、部署、備份/還原)
- 安全強化 (防火牆、UFW、僅限 SSH 存取)
- 用於 Gateway 存取的 SSH 通道設定

**儲存庫：**

- 基礎設施：[openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker 設定：[openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

這種方法透過可重現的部署、版本控制的基礎設施和自動化的災難復原，補充了上述 Docker 設定。

> **請注意：** 社群維護。有關問題或貢獻，請參閱上面的儲存庫連結。
