---
summary: "選用的 Docker 型 OpenClaw 設定與新手導覽"
read_when:
  - 您想要一個容器化的 Gateway 而非本機安裝
  - 您正在驗證 Docker 流程
title: "Docker"
---

# Docker (選用)

Docker 是**選用**的。僅在您想要一個容器化的 Gateway 或驗證 Docker 流程時使用。

## Docker 適合我嗎？

- **是**：您想要一個隔離、拋棄式的 Gateway 環境，或在不進行本機安裝的情況下於主機上執行 OpenClaw。
- **否**：您在自己的機器上執行，且只想要最快的開發循環。請改用一般的安裝流程。
- **沙箱注意事項**：智慧代理沙箱隔離也會使用 Docker，但**不**要求整個 Gateway 都在 Docker 中執行。請參閱 [沙箱隔離](/gateway/sandboxing)。

本指南涵蓋：

- 容器化 Gateway (完整的 OpenClaw 執行於 Docker)
- 每個工作階段的智慧代理沙箱 (主機 Gateway + Docker 隔離的智慧代理工具)

沙箱隔離詳情：[沙箱隔離](/gateway/sandboxing)

## 需求

- Docker Desktop (或 Docker Engine) + Docker Compose v2
- 足夠的磁碟空間供映像檔與日誌使用

## 容器化 Gateway (Docker Compose)

### 快速開始 (建議使用)

從儲存庫根目錄執行：

```bash
./docker-setup.sh
```

此指令碼會：

- 建置 Gateway 映像檔
- 執行新手導覽精靈
- 列印選用的供應商設定提示
- 透過 Docker Compose 啟動 Gateway
- 產生一個 Gateway token 並寫入 `.env`

選用的環境變數：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在建置期間安裝額外的 apt 套件
- `OPENCLAW_EXTRA_MOUNTS` — 新增額外的主機綁定掛載 (bind mounts)
- `OPENCLAW_HOME_VOLUME` — 將 `/home/node` 持久化於具名磁碟卷 (named volume) 中

完成後：

- 在瀏覽器中開啟 `http://127.0.0.1:18789/`。
- 將 token 貼入控制介面 (Settings → token)。
- 需要再次查看 URL？執行 `docker compose run --rm openclaw-cli dashboard --no-open`。

它會在主機上寫入設定/工作區：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上執行？請參閱 [Hetzner (Docker VPS)](/install/hetzner)。

### Shell 輔助工具 (選用)

為了更輕鬆地進行日常 Docker 管理，請安裝 `ClawDock`：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**新增至您的 shell 設定 (zsh)：**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

接著可以使用 `clawdock-start`、`clawdock-stop`、`clawdock-dashboard` 等指令。執行 `clawdock-help` 查看所有指令。

詳情請參閱 [`ClawDock` 輔助工具 README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)。

### 手動流程 (Compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：請在儲存庫根目錄執行 `docker compose ...`。如果您啟用了
`OPENCLAW_EXTRA_MOUNTS` 或 `OPENCLAW_HOME_VOLUME`，設定指令碼會寫入
`docker-compose.extra.yml`；在其他地方執行 Compose 時請包含它：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制介面 token + 配對 (Docker)

如果您看到 “unauthorized” 或 “disconnected (1008): pairing required”，請獲取
新的儀表板連結並核准瀏覽器裝置：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

更多詳情：[儀表板](/web/dashboard)、[裝置](/cli/devices)。

### 額外掛載 (選用)

如果您想將額外的主機目錄掛載到容器中，請在執行 `docker-setup.sh` 之前設定
`OPENCLAW_EXTRA_MOUNTS`。這接受以逗號分隔的 Docker 綁定掛載列表，並透過產生 `docker-compose.extra.yml` 將其套用於 `openclaw-gateway` 和 `openclaw-cli`。

範例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 在 macOS/Windows 上，路徑必須與 Docker Desktop 共用。
- 如果您編輯了 `OPENCLAW_EXTRA_MOUNTS`，請重新執行 `docker-setup.sh` 以重新產生額外的 Compose 檔案。
- `docker-compose.extra.yml` 是自動產生的。請勿手動編輯它。

### 持久化整個容器 home 目錄 (選用)

如果您希望 `/home/node` 在容器重建後依然存在，請透過 `OPENCLAW_HOME_VOLUME` 設定一個具名磁碟卷。這會建立一個 Docker 磁碟卷並將其掛載於 `/home/node`，同時保留標準的設定/工作區綁定掛載。此處請使用具名磁碟卷（而非綁定路徑）；若要使用綁定掛載，請使用 `OPENCLAW_EXTRA_MOUNTS`。

範例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

您可以將其與額外掛載結合使用：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 如果您更改了 `OPENCLAW_HOME_VOLUME`，請重新執行 `docker-setup.sh` 以重新產生額外的 Compose 檔案。
- 具名磁碟卷會一直保留，直到使用 `docker volume rm <name>` 將其刪除。

### 安裝額外的 apt 套件 (選用)

如果您需要在映像檔內安裝系統套件（例如建置工具或多媒體函式庫），請在執行 `docker-setup.sh` 之前設定 `OPENCLAW_DOCKER_APT_PACKAGES`。這會在映像檔建置期間安裝套件，因此即使容器被刪除，套件仍會保留。

範例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意：

- 這接受以空格分隔的 apt 套件名稱列表。
- 如果您更改了 `OPENCLAW_DOCKER_APT_PACKAGES`，請重新執行 `docker-setup.sh` 以重新建置映像檔。

### 進階使用者 / 全功能容器 (選擇性加入)

預設的 Docker 映像檔是**安全性優先**，並以非 root 的 `node` 使用者執行。這可以縮小受攻擊面，但也意味著：

- 執行期間無法安裝系統套件
- 預設沒有 Homebrew
- 沒有內建 Chromium/Playwright 瀏覽器

如果您想要一個功能更完整的容器，請使用這些選擇性加入的設定：

1. **持久化 `/home/node`**，讓瀏覽器下載內容和工具快取得以保留：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **將系統依賴項燒錄至映像檔** (可重複且持久)：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **不使用 `npx` 安裝 Playwright 瀏覽器** (避免 npm 覆蓋衝突)：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

如果您需要 Playwright 安裝系統依賴項，請使用 `OPENCLAW_DOCKER_APT_PACKAGES` 重新建置映像檔，而非在執行期間使用 `--with-deps`。

4. **持久化 Playwright 瀏覽器下載內容**：

- 在 `docker-compose.yml` 中設定 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
- 確保 `/home/node` 透過 `OPENCLAW_HOME_VOLUME` 持久化，或透過 `OPENCLAW_EXTRA_MOUNTS` 掛載 `/home/node/.cache/ms-playwright`。

### 權限 + EACCES

映像檔以 `node` (uid 1000) 執行。如果您看到 `/home/node/.openclaw` 的權限錯誤，請確保您的主機綁定掛載是由 uid 1000 擁有的。

範例 (Linux 主機)：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

如果您為了方便而選擇以 root 執行，則須承擔安全性風險。

### 更快的重新建置 (建議使用)

為了加快重新建置速度，請調整 Dockerfile 的順序以便快取依賴層。除非 lockfile 更改，否則這可以避免重新執行 `pnpm install`：

```dockerfile
FROM node:22-bookworm

# 安裝 Bun (建置指令碼所需)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# 除非套件元數據更改，否則快取依賴項
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### 頻道設定 (選用)

使用 CLI 容器設定頻道，如有需要請重啟 Gateway。

WhatsApp (QR)：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (機器人 token)：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (機器人 token)：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

文件：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

### OpenAI Codex OAuth (無介面 Docker)

如果您在精靈中選擇 OpenAI Codex OAuth，它會開啟一個瀏覽器 URL 並嘗試在 `http://127.0.0.1:1455/auth/callback` 擷取回呼 (callback)。在 Docker 或無介面設定中，該回呼可能會顯示瀏覽器錯誤。請複製您抵達的完整重新導向 URL，並將其貼回精靈中以完成認證。

### 健康檢查

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 冒煙測試 (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR 匯入冒煙測試 (Docker)

```bash
pnpm test:docker:qr
```

### 注意事項

- Gateway 綁定預設為 `lan` 供容器使用。
- Dockerfile CMD 使用 `--allow-unconfigured`；即使掛載的設定中 `gateway.mode` 不是 `local`，仍會啟動。覆蓋 CMD 以強制執行守衛。
- Gateway 容器是工作階段 (`~/.openclaw/agents/<agentId>/sessions/`) 的單一事實來源。

## 智慧代理沙箱 (主機 Gateway + Docker 工具)

深入探討：[沙箱隔離](/gateway/sandboxing)

### 它的作用

當啟用 `agents.defaults.sandbox` 時，**非主要工作階段 (non-main sessions)** 會在 Docker 容器內執行工具。Gateway 留在您的主機上，但工具的執行是被隔離的：

- 範圍：預設為 `"agent"` (每個智慧代理一個容器與工作區)
- 範圍：`"session"` 用於各個工作階段的隔離
- 各範圍的工作區資料夾掛載於 `/workspace`
- 選用的智慧代理工作區存取權 (`agents.defaults.sandbox.workspaceAccess`)
- 允許/拒絕工具原則 (拒絕優先)
- 傳入的媒體會被複製到作用中的沙箱工作區 (`media/inbound/*`)，以便工具讀取 (若 `workspaceAccess: "rw"`，這會落在智慧代理工作區中)

警告：`scope: "shared"` 會停用跨工作階段隔離。所有工作階段共用一個容器和一個工作區。

### 每個智慧代理的沙箱設定檔 (多智慧代理)

如果您使用多智慧代理路由，每個智慧代理都可以覆蓋沙箱與工具設定：`agents.list[].sandbox` 和 `agents.list[].tools` (以及 `agents.list[].tools.sandbox.tools`)。這讓您可以在一個 Gateway 中執行混合的存取層級：

- 完全存取 (個人智慧代理)
- 唯讀工具 + 唯讀工作區 (家庭/工作智慧代理)
- 無檔案系統/shell 工具 (公開智慧代理)

範例、優先順序和疑難排解請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools)。

### 預設行為

- 映像檔：`openclaw-sandbox:bookworm-slim`
- 每個智慧代理一個容器
- 智慧代理工作區存取權：預設 `workspaceAccess: "none"` 使用 `~/.openclaw/sandboxes`
  - `"ro"` 將沙箱工作區保留在 `/workspace` 並將智慧代理工作區以唯讀方式掛載於 `/agent` (停用 `write`/`edit`/`apply_patch`)
  - `"rw"` 將智慧代理工作區以讀寫方式掛載於 `/workspace`
- 自動清理：閒置 > 24小時 或 存在時間 > 7天
- 網路：預設為 `none` (若需要連外網路，請明確選擇加入)
- 預設允許：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 預設拒絕：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 啟用沙箱隔離

如果您打算在 `setupCommand` 中安裝套件，請注意：

- 預設 `docker.network` 為 `"none"` (無連外網路)。
- `readOnlyRoot: true` 會阻擋套件安裝。
- `user` 必須為 root 才能執行 `apt-get` (省略 `user` 或設定為 `user: "0:0"`)。
  當 `setupCommand` (或 docker 設定) 更改時，OpenClaw 會自動重建容器，除非該容器**最近曾被使用** (約 5 分鐘內)。熱容器會記錄警告並提供確切的 `openclaw sandbox recreate ...` 指令。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (預設為 agent)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 停用閒置清理
          maxAgeDays: 7, // 0 停用最大天數清理
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

強化旋鈕位於 `agents.defaults.sandbox.docker` 下：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`。

多智慧代理：可透過 `agents.list[].sandbox.{docker,browser,prune}.*` 針對每個智慧代理覆蓋 `agents.defaults.sandbox.{docker,browser,prune}.*`
(當 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 為 `"shared"` 時會被忽略)。

### 建置預設沙箱映像檔

```bash
scripts/sandbox-setup.sh
```

這會使用 `Dockerfile.sandbox` 建置 `openclaw-sandbox:bookworm-slim`。

### 沙箱通用映像檔 (選用)

如果您想要一個包含常用建置工具 (Node, Go, Rust 等) 的沙箱映像檔，請建置通用映像檔：

```bash
scripts/sandbox-common-setup.sh
```

這會建置 `openclaw-sandbox-common:bookworm-slim`。要使用它：

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### 沙箱瀏覽器映像檔

要在沙箱內執行瀏覽器工具，請建置瀏覽器映像檔：

```bash
scripts/sandbox-browser-setup.sh
```

這會使用 `Dockerfile.sandbox-browser` 建置 `openclaw-sandbox-browser:bookworm-slim`。該容器會執行啟用了 CDP 的 Chromium，以及選用的 noVNC 觀察器 (透過 Xvfb 的 headful 模式)。

注意：

- 與 headless 模式相比，Headful (Xvfb) 模式可減少被判定為機器人而遭阻擋的機率。
- 透過設定 `agents.defaults.sandbox.browser.headless=true` 仍可使用 headless 模式。
- 不需要完整的桌面環境 (GNOME)；Xvfb 會提供顯示輸出。

使用設定：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

自訂瀏覽器映像檔：

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

啟用後，智慧代理會收到：

- 一個沙箱瀏覽器控制 URL (用於 `browser` 工具)
- 一個 noVNC URL (如果已啟用且 headless=false)

請記住：如果您對工具使用允許列表，請新增 `browser` (並從拒絕列表中移除)，否則該工具仍會被阻擋。
清理規則 (`agents.defaults.sandbox.prune`) 也會套用於瀏覽器容器。

### 自訂沙箱映像檔

建置您自己的映像檔並將設定指向它：

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### 工具原則 (允許/拒絕)

- `deny` (拒絕) 的優先權高於 `allow` (允許)。
- 如果 `allow` 為空：所有工具 (除拒絕列表外) 皆可用。
- 如果 `allow` 不為空：僅 `allow` 中的工具可用 (須扣除拒絕列表)。

### 清理策略

兩個旋鈕：

- `prune.idleHours`：移除 X 小時未使用的容器 (0 = 停用)
- `prune.maxAgeDays`：移除存在超過 X 天的容器 (0 = 停用)

範例：

- 保留活躍的工作階段但限制生命週期：
  `idleHours: 24`, `maxAgeDays: 7`
- 永不清理：
  `idleHours: 0`, `maxAgeDays: 0`

### 安全性說明

- 硬性隔離僅套用於**工具** (exec/read/write/edit/apply_patch)。
- 僅限主機的工具（如瀏覽器、相機、畫布）預設會被阻擋。
- 在沙箱中允許 `browser` **會破壞隔離** (瀏覽器執行於主機上)。

## 疑難排解

- 缺少映像檔：使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 建置，或設定 `agents.defaults.sandbox.docker.image`。
- 容器未執行：它會根據需求針對每個工作階段自動建立。
- 沙箱中的權限錯誤：將 `docker.user` 設定為與您掛載的工作區擁有者相符的 UID:GID (或 chown 該工作區資料夾)。
- 找不到自訂工具：OpenClaw 以 `sh -lc` (登入 shell) 執行指令，這會載入 `/etc/profile` 並可能重設 PATH。請設定 `docker.env.PATH` 以在前方加入您的自訂工具路徑 (例如 `/custom/bin:/usr/local/share/npm-global/bin`)，或在 Dockerfile 的 `/etc/profile.d/` 下新增指令碼。
