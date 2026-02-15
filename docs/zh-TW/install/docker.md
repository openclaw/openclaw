---
summary: "OpenClaw 選擇性的 Docker-based 設定與新手導覽"
read_when:
  - 您需要容器化的 Gateway 而非本機安裝
  - 您正在驗證 Docker 流程
title: "Docker"
---

# Docker (選擇性)

Docker 是**選擇性**的。僅在您需要容器化的 Gateway 或驗證 Docker 流程時才使用它。

## Docker 適合我嗎？

- **是**：您需要一個隔離的、拋棄式的 Gateway 環境，或在沒有本機安裝的主機上執行 OpenClaw。
- **否**：您在自己的機器上執行，只想要最快的開發循環。請改用標準安裝流程。
- **沙箱注意事項**：智慧代理沙箱隔離也使用 Docker，但它**不**要求整個 Gateway 在 Docker 中執行。請參閱 [沙箱隔離](/gateway/sandboxing)。

本指南涵蓋：

- 容器化的 Gateway (Docker 中的完整 OpenClaw)
- 每工作階段的智慧代理沙箱 (主機 Gateway + Docker 隔離的智慧代理工具)

沙箱隔離詳細資訊：[沙箱隔離](/gateway/sandboxing)

## 需求

- Docker Desktop (或 Docker Engine) + Docker Compose v2
- 足夠的磁碟空間用於映像檔 + 記錄

## 容器化的 Gateway (Docker Compose)

### 快速開始 (建議)

從儲存庫根目錄：

```bash
./docker-setup.sh
```

此指令碼：

- 建置 Gateway 映像檔
- 執行新手導覽精靈
- 列印選擇性的供應商設定提示
- 透過 Docker Compose 啟動 Gateway
- 產生一個 Gateway 權杖並寫入到 `.env` 檔案

選擇性的環境變數：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在建置期間安裝額外的 apt 檔案
- `OPENCLAW_EXTRA_MOUNTS` — 新增額外的主機綁定掛載
- `OPENCLAW_HOME_VOLUME` — 將 `/home/node` 持續儲存到具名磁碟區中

完成後：

- 在您的瀏覽器中開啟 `http://127.0.0.1:18789/`。
- 將權杖貼入控制 UI (設定 → 權杖)。
- 需要再次取得 URL 嗎？執行 `docker compose run --rm openclaw-cli dashboard --no-open`。

它將設定/工作區寫入主機：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上執行嗎？請參閱 [Hetzner (Docker VPS)](/install/hetzner)。

### Shell 輔助程式 (選擇性)

為了更容易地進行日常 Docker 管理，請安裝 `ClawDock`：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**新增到您的 shell 設定 (zsh)：**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

然後使用 `clawdock-start`、`clawdock-stop`、`clawdock-dashboard` 等指令。執行 `clawdock-help` 查看所有指令。

有關詳細資訊，請參閱 [`ClawDock` 輔助程式 README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)。

### 手動流程 (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：從儲存庫根目錄執行 `docker compose ...`。如果您啟用了
`OPENCLAW_EXTRA_MOUNTS` 或 `OPENCLAW_HOME_VOLUME`，設定指令碼會寫入
`docker-compose.extra.yml`；在其他地方執行 Compose 時請包含它：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制 UI 權杖 + 配對 (Docker)

如果您看到「未經授權」或「斷開連線 (1008)：需要配對」，請獲取
新的儀表板連結並批准瀏覽器裝置：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

更多詳細資訊：[儀表板](/web/dashboard)，[裝置](/cli/devices)。

### 額外掛載 (選擇性)

如果您想將額外的主機目錄掛載到容器中，請在執行 `docker-setup.sh` 之前設定
`OPENCLAW_EXTRA_MOUNTS`。這接受逗號分隔的 Docker 綁定掛載列表，並透過生成
`docker-compose.extra.yml` 將其應用於 `openclaw-gateway` 和 `openclaw-cli`。

範例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事項：

- 在 macOS/Windows 上，路徑必須與 Docker Desktop 共享。
- 如果您編輯 `OPENCLAW_EXTRA_MOUNTS`，請重新執行 `docker-setup.sh` 以重新生成
  額外的 compose 檔案。
- `docker-compose.extra.yml` 是自動生成的。請勿手動編輯。

### 持續儲存整個容器主目錄 (選擇性)

如果您希望 `/home/node` 在容器重新建立後仍然持續存在，請透過 `OPENCLAW_HOME_VOLUME` 設定具名磁碟區。
這會建立一個 Docker 磁碟區並將其掛載到 `/home/node`，同時保留標準的設定/工作區綁定掛載。
這裡使用具名磁碟區 (而不是綁定路徑)；對於綁定掛載，請使用 `OPENCLAW_EXTRA_MOUNTS`。

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

注意事項：

- 如果您變更 `OPENCLAW_HOME_VOLUME`，請重新執行 `docker-setup.sh` 以重新生成
  額外的 compose 檔案。
- 具名磁碟區會持續存在，直到使用 `docker volume rm <name>` 移除為止。

### 安裝額外的 apt 檔案 (選擇性)

如果您需要在映像檔中安裝系統檔案 (例如，建置工具或媒體函式庫)，請在執行
`docker-setup.sh` 之前設定 `OPENCLAW_DOCKER_APT_PACKAGES`。這會在映像檔建置期間
安裝檔案，因此即使容器被刪除，它們也會持續存在。

範例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意事項：

- 這接受以空格分隔的 apt 檔案名稱列表。
- 如果您變更 `OPENCLAW_DOCKER_APT_PACKAGES`，請重新執行 `docker-setup.sh` 以重新建置
  映像檔。

### 進階使用者 / 功能齊全的容器 (選擇加入)

預設的 Docker 映像檔是**安全優先**的，並以非 root `node` 使用者執行。
這可以縮小攻擊面，但這也表示：

- 執行時無法安裝系統檔案
- 預設沒有 Homebrew
- 沒有捆綁 Chromium/Playwright 瀏覽器

如果您需要功能更齊全的容器，請使用這些選擇加入的選項：

1.  **持續儲存 `/home/node`**，以便瀏覽器下載和工具快取能夠存留：

    ```bash
    export OPENCLAW_HOME_VOLUME="openclaw_home"
    ./docker-setup.sh
    ```

2.  **將系統依賴項整合到映像檔中** (可重複 + 持續存在)：

    ```bash
    export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
    ./docker-setup.sh
    ```

3.  **不安裝 `npx` 即可安裝 Playwright 瀏覽器** (避免 npm 覆寫衝突)：

    ```bash
    docker compose run --rm openclaw-cli \
      node /app/node_modules/playwright-core/cli.js install chromium
    ```

    如果您需要 Playwright 安裝系統依賴項，請使用 `OPENCLAW_DOCKER_APT_PACKAGES`
    重新建置映像檔，而不是在執行時使用 `--with-deps`。

4.  **持續儲存 Playwright 瀏覽器下載**：

    - 在 `docker-compose.yml` 中設定 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
    - 確保 `/home/node` 透過 `OPENCLAW_HOME_VOLUME` 持續存在，或者透過 `OPENCLAW_EXTRA_MOUNTS` 掛載
      `/home/node/.cache/ms-playwright`。

### 權限 + EACCES

映像檔以 `node` (uid 1000) 執行。如果您在
`/home/node/.openclaw` 上看到權限錯誤，請確保您的主機綁定掛載由 uid 1000 擁有。

範例 (Linux 主機)：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

如果您選擇為了方便而以 root 執行，您將承擔安全性權衡。

### 更快的重建 (建議)

為了加快重建速度，請按照依賴層順序排列您的 Dockerfile，以便快取。
這可以避免重新執行 `pnpm install`，除非 lockfile 變更：

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
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

### 頻道設定 (選擇性)

使用 CLI 容器設定頻道，然後在需要時重新啟動 Gateway。

WhatsApp (QR)：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (機器人權杖)：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (機器人權杖)：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

文件：[WhatsApp](/channels/whatsapp)，[Telegram](/channels/telegram)，[Discord](/channels/discord)

### OpenAI Codex OAuth (無頭 Docker)

如果您在精靈中選擇 OpenAI Codex OAuth，它會打開一個瀏覽器 URL 並嘗試在
`http://127.0.0.1:1455/auth/callback` 上捕獲回呼。在 Docker 或
無頭設定中，該回呼可能會顯示瀏覽器錯誤。複製您登陸的完整重新導向 URL，並將其貼回
精靈以完成憑證。

### 健康檢查

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### 端到端冒煙測試 (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR 匯入冒煙測試 (Docker)

```bash
pnpm test:docker:qr
```

### 注意事項

- Gateway 綁定預設為 `lan` 以供容器使用。
- Dockerfile CMD 使用 `--allow-unconfigured`；掛載的設定檔中 `gateway.mode`
  不是 `local` 仍會啟動。覆寫 CMD 以強制執行防護。
- Gateway 容器是工作階段的事實來源 (`~/.openclaw/agents/<agentId>/sessions/`)。

## 智慧代理沙箱 (主機 Gateway + Docker 工具)

深入探討：[沙箱隔離](/gateway/sandboxing)

### 功能

當啟用 `agents.defaults.sandbox` 時，**非主要工作階段**會在 Docker 容器內執行工具。
Gateway 仍然保留在您的主機上，但工具執行是隔離的：

- 範圍：預設為 `"agent"` (每個智慧代理一個容器 + 工作區)
- 範圍：`"session"` 用於每個工作階段隔離
- 在 `/workspace` 掛載每個範圍的工作區資料夾
- 選擇性的智慧代理工作區存取 (`agents.defaults.sandbox.workspaceAccess`)
- 允許/拒絕工具策略 (拒絕優先)
- 入站媒體會複製到活動沙箱工作區 (`media/inbound/*`)，以便工具可以讀取它
  (如果 `workspaceAccess: "rw"`，則會放置在智慧代理工作區中)

警告：`scope: "shared"` 會停用跨工作階段隔離。所有工作階段共用一個容器和一個工作區。

### 每個智慧代理的沙箱設定檔 (多智慧代理)

如果您使用多智慧代理路由，每個智慧代理都可以覆寫沙箱 + 工具設定：
`agents.list[].sandbox` 和 `agents.list[].tools` (加上 `agents.list[].tools.sandbox.tools`)。
這讓您可以在一個 Gateway 中執行混合存取層級：

- 完整存取 (個人智慧代理)
- 唯讀工具 + 唯讀工作區 (家庭/工作智慧代理)
- 沒有檔案系統/shell 工具 (公共智慧代理)

請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以獲取範例、
優先順序和疑難排解。

### 預設行為

- 映像檔：`openclaw-sandbox:bookworm-slim`
- 每個智慧代理一個容器
- 智慧代理工作區存取：`workspaceAccess: "none"` (預設) 使用 `~/.openclaw/sandboxes`
  - `"ro"` 將沙箱工作區保留在 `/workspace`，並將智慧代理工作區以唯讀方式掛載到 `/agent` (停用 `write`/`edit`/`apply_patch`)
  - `"rw"` 將智慧代理工作區以讀寫方式掛載到 `/workspace`
- 自動修剪：閒置 > 24 小時 或 存活期 > 7 天
- 網路：預設為 `none` (如果需要 egress，請明確選擇加入)
- 預設允許：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 預設拒絕：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 啟用沙箱隔離

如果您計劃在 `setupCommand` 中安裝檔案，請注意：

- 預設的 `docker.network` 是 `"none"` (無 egress)。
- `readOnlyRoot: true` 會阻止檔案安裝。
- `user` 必須是 root 才能使用 `apt-get` (省略 `user` 或設定 `user: "0:0"`)。
  OpenClaw 會在 `setupCommand` (或 docker 設定) 變更時自動重新建立容器，
  除非容器最近使用過 (約 5 分鐘內)。熱容器會記錄一個帶有確切 `openclaw sandbox recreate ...` 指令的警告。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
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
          idleHours: 24, // 0 停用閒置修剪
          maxAgeDays: 7, // 0 停用最大存活期修剪
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

強化選項位於 `agents.defaults.sandbox.docker` 下方：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`。

多智慧代理：透過 `agents.list[].sandbox.{docker,browser,prune}.*`
覆寫每個智慧代理的 `agents.defaults.sandbox.{docker,browser,prune}.*`
(當 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 為 `"shared"` 時忽略)。

### 建置預設沙箱映像檔

```bash
scripts/sandbox-setup.sh
```

這會使用 `Dockerfile.sandbox` 建置 `openclaw-sandbox:bookworm-slim`。

### 沙箱通用映像檔 (選擇性)

如果您需要一個包含常用建置工具 (Node、Go、Rust 等) 的沙箱映像檔，請建置通用映像檔：

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

這會使用 `Dockerfile.sandbox-browser` 建置 `openclaw-sandbox-browser:bookworm-slim`。
容器執行帶有 CDP 啟用和選擇性 noVNC 觀察器 (透過 Xvfb 的 Headful 模式) 的 Chromium。

注意事項：

- Headful (Xvfb) 模式比 Headless 模式更能減少機器人阻擋。
- Headless 模式仍可透過設定 `agents.defaults.sandbox.browser.headless=true` 使用。
- 不需要完整的桌面環境 (GNOME)；Xvfb 提供顯示。

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

- 沙箱瀏覽器控制 URL (用於 `browser` 工具)
- noVNC URL (如果啟用且 `headless=false`)

請記住：如果您為工具使用允許列表，請新增 `browser` (並將其從拒絕列表中移除)，否則工具仍將被封鎖。
修剪規則 (`agents.defaults.sandbox.prune`) 也適用於瀏覽器容器。

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

### 工具策略 (允許/拒絕)

- `deny` 優先於 `allow`。
- 如果 `allow` 為空：所有工具 (除了拒絕的) 都可用。
- 如果 `allow` 不為空：只有 `allow` 中的工具可用 (減去拒絕的)。

### 修剪策略

兩個選項：

- `prune.idleHours`：移除 X 小時內未使用的容器 (0 = 停用)
- `prune.maxAgeDays`：移除超過 X 天的容器 (0 = 停用)

範例：

- 保持忙碌的工作階段，但限制存活期：
  `idleHours: 24`，`maxAgeDays: 7`
- 從不修剪：
  `idleHours: 0`，`maxAgeDays: 0`

### 安全性注意事項

- 硬隔離僅適用於**工具** (exec/read/write/edit/apply_patch)。
- 預設情況下，僅限主機的工具（例如瀏覽器/攝影機/畫布）被阻止。
- 在沙箱中允許 `browser` 會**破壞隔離** (瀏覽器在主機上執行)。

## 疑難排解

- 映像檔遺失：使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)
  建置，或設定 `agents.defaults.sandbox.docker.image`。
- 容器未執行：它將根據需求自動為每個工作階段建立。
- 沙箱中的權限錯誤：將 `docker.user` 設定為與您掛載的工作區擁有權相符的 UID:GID
  (或變更工作區資料夾的擁有權)。
- 未找到自訂工具：OpenClaw 執行指令時使用 `sh -lc` (登入 shell)，它會載入
  `/etc/profile` 並可能重設 PATH。設定 `docker.env.PATH` 以在前面加上您的
  自訂工具路徑 (例如，`/custom/bin:/usr/local/share/npm-global/bin`)，
  或在您的 Dockerfile 中於 `/etc/profile.d/` 下新增指令碼。
