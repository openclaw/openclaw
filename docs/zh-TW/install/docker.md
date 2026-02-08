---
summary: 「OpenClaw 的可選 Docker 型設定與入門引導」
read_when:
  - 「你想要使用容器化的 Gateway 閘道器，而非本機安裝」
  - 「你正在驗證 Docker 流程」
title: 「Docker」
x-i18n:
  source_path: install/docker.md
  source_hash: fb8c7004b18753a2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:58Z
---

# Docker（可選）

Docker 是**可選**的。只有在你想要使用容器化的 Gateway 閘道器，或要驗證 Docker 流程時才使用。

## Docker 適合我嗎？

- **是**：你想要一個隔離、可丟棄的 Gateway 閘道器環境，或在沒有本機安裝的主機上執行 OpenClaw。
- **否**：你是在自己的機器上執行，只想要最快的開發迴圈。請改用一般安裝流程。
- **沙箱隔離注意事項**：代理程式沙箱隔離也會使用 Docker，但**不**需要整個 Gateway 閘道器都在 Docker 中執行。請參閱 [Sandboxing](/gateway/sandboxing)。

本指南涵蓋：

- 容器化 Gateway 閘道器（在 Docker 中執行完整的 OpenClaw）
- 每個工作階段的代理程式沙箱（主機上的 Gateway 閘道器 + Docker 隔離的代理程式工具）

沙箱隔離詳情：[Sandboxing](/gateway/sandboxing)

## 需求

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 足夠的磁碟空間用於映像檔與記錄

## 容器化 Gateway 閘道器（Docker Compose）

### 快速開始（建議）

在儲存庫根目錄執行：

```bash
./docker-setup.sh
```

此腳本會：

- 建置 Gateway 閘道器映像檔
- 執行入門引導精靈
- 印出可選的提供者設定提示
- 透過 Docker Compose 啟動 Gateway 閘道器
- 產生 Gateway 閘道器權杖，並寫入 `.env`

可選的環境變數：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在建置期間安裝額外的 apt 套件
- `OPENCLAW_EXTRA_MOUNTS` — 新增額外的主機綁定掛載
- `OPENCLAW_HOME_VOLUME` — 以具名磁碟區保存 `/home/node`

完成後：

- 在瀏覽器中開啟 `http://127.0.0.1:18789/`。
- 將權杖貼到控制 UI（Settings → token）。
- 需要再次取得 URL？請執行 `docker compose run --rm openclaw-cli dashboard --no-open`。

它會在主機上寫入設定／工作區：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上執行？請參閱 [Hetzner（Docker VPS）](/install/hetzner)。

### 手動流程（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：請在儲存庫根目錄執行 `docker compose ...`。如果你啟用了
`OPENCLAW_EXTRA_MOUNTS` 或 `OPENCLAW_HOME_VOLUME`，設定腳本會寫入
`docker-compose.extra.yml`；在其他地方執行 Compose 時請一併包含：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制 UI 權杖 + 配對（Docker）

如果你看到「unauthorized」或「disconnected (1008): pairing required」，請取得新的儀表板連結並核准瀏覽器裝置：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

更多說明：[Dashboard](/web/dashboard)、[Devices](/cli/devices)。

### 額外掛載（可選）

如果你想要將額外的主機目錄掛載到容器中，請在執行
`docker-setup.sh` 之前設定 `OPENCLAW_EXTRA_MOUNTS`。它接受以逗號分隔的 Docker 綁定掛載清單，並透過產生 `docker-compose.extra.yml`，將其套用到
`openclaw-gateway` 與 `openclaw-cli`。

範例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事項：

- 在 macOS／Windows 上，路徑必須已與 Docker Desktop 共用。
- 如果你編輯了 `OPENCLAW_EXTRA_MOUNTS`，請重新執行 `docker-setup.sh` 以重新產生額外的 compose 檔案。
- `docker-compose.extra.yml` 是自動產生的。請勿手動編輯。

### 保存整個容器 home（可選）

如果你希望 `/home/node` 在重新建立容器後仍能保留，請透過
`OPENCLAW_HOME_VOLUME` 設定具名磁碟區。這會建立一個 Docker 磁碟區並掛載到
`/home/node`，同時保留標準的設定／工作區綁定掛載。此處請使用具名磁碟區（不要使用綁定路徑）；若要使用綁定掛載，請改用
`OPENCLAW_EXTRA_MOUNTS`。

範例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

你可以將它與額外掛載一起使用：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事項：

- 如果你變更了 `OPENCLAW_HOME_VOLUME`，請重新執行 `docker-setup.sh` 以重新產生額外的 compose 檔案。
- 具名磁碟區會一直保留，直到使用 `docker volume rm <name>` 移除為止。

### 安裝額外的 apt 套件（可選）

如果你需要在映像檔內安裝系統套件（例如建置工具或媒體函式庫），請在執行
`docker-setup.sh` 之前設定 `OPENCLAW_DOCKER_APT_PACKAGES`。
這會在映像檔建置期間安裝套件，因此即使容器被刪除也會保留。

範例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意事項：

- 此設定接受以空白分隔的 apt 套件名稱清單。
- 如果你變更了 `OPENCLAW_DOCKER_APT_PACKAGES`，請重新執行 `docker-setup.sh` 以重新建置映像檔。

### 進階使用者／完整功能容器（選用）

預設的 Docker 映像檔以**安全性優先**，並以非 root 的 `node`
使用者身分執行。這能縮小攻擊面，但也代表：

- 執行時無法安裝系統套件
- 預設沒有 Homebrew
- 未內建 Chromium／Playwright 瀏覽器

如果你想要功能更完整的容器，請使用以下選用開關：

1. **保存 `/home/node`**，讓瀏覽器下載與工具快取得以保留：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **將系統相依套件烘焙進映像檔**（可重複且持久）：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **在不使用 `npx` 的情況下安裝 Playwright 瀏覽器**（避免 npm 覆寫衝突）：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

如果你需要讓 Playwright 安裝系統相依套件，請使用
`OPENCLAW_DOCKER_APT_PACKAGES` 重新建置映像檔，而不是在執行時使用 `--with-deps`。

4. **保存 Playwright 瀏覽器下載內容**：

- 在 `docker-compose.yml` 中設定 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
- 透過 `OPENCLAW_HOME_VOLUME` 確保 `/home/node` 會被保留，或透過 `OPENCLAW_EXTRA_MOUNTS` 掛載 `/home/node/.cache/ms-playwright`。

### 權限 + EACCES

映像檔以 `node`（uid 1000）執行。如果你在
`/home/node/.openclaw` 上看到權限錯誤，請確認你的主機綁定掛載由 uid 1000 擁有。

範例（Linux 主機）：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

如果你為了方便而選擇以 root 執行，代表你接受相應的安全性取捨。

### 更快的重新建置（建議）

為了加速重新建置，請調整 Dockerfile 的順序，讓相依套件層能被快取。
如此一來，除非鎖定檔變更，否則不需要重新執行 `pnpm install`：

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

### 頻道設定（可選）

使用 CLI 容器來設定頻道，必要時再重新啟動 Gateway 閘道器。

WhatsApp（QR）：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram（機器人權杖）：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord（機器人權杖）：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

文件：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

### OpenAI Codex OAuth（無頭 Docker）

如果你在精靈中選擇 OpenAI Codex OAuth，它會開啟一個瀏覽器 URL，並嘗試在
`http://127.0.0.1:1455/auth/callback` 上接收回呼。在 Docker 或無頭環境中，該回呼可能會顯示瀏覽器錯誤。請複製你最終到達的完整重新導向 URL，並貼回精靈以完成身分驗證。

### 健康檢查

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 冒煙測試（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QR 匯入冒煙測試（Docker）

```bash
pnpm test:docker:qr
```

### 注意事項

- Gateway 閘道器綁定預設為 `lan`，以供容器使用。
- Dockerfile 的 CMD 使用 `--allow-unconfigured`；使用 `gateway.mode` 而非 `local` 掛載的設定仍可啟動。若要強制檢查，請覆寫 CMD。
- Gateway 閘道器容器是工作階段（`~/.openclaw/agents/<agentId>/sessions/`）的事實來源。

## 代理程式沙箱（主機 Gateway 閘道器 + Docker 工具）

深入說明：[Sandboxing](/gateway/sandboxing)

### 功能說明

當啟用 `agents.defaults.sandbox` 時，**非主要工作階段** 會在 Docker
容器中執行工具。Gateway 閘道器仍留在你的主機上，但工具執行會被隔離：

- 範圍：預設為 `"agent"`（每個代理程式一個容器 + 工作區）
- 範圍：`"session"` 用於每個工作階段的隔離
- 每個範圍的工作區資料夾會掛載於 `/workspace`
- 可選的代理程式工作區存取（`agents.defaults.sandbox.workspaceAccess`）
- 工具允許／拒絕政策（拒絕優先）
- 進站媒體會被複製到作用中的沙箱工作區（`media/inbound/*`），讓工具可讀取（搭配 `workspaceAccess: "rw"` 時，會落在代理程式工作區）

警告：`scope: "shared"` 會停用跨工作階段的隔離。所有工作階段會共用
一個容器與一個工作區。

### 每個代理程式的沙箱設定檔（多代理程式）

如果你使用多代理程式路由，每個代理程式都可以覆寫沙箱與工具設定：
`agents.list[].sandbox` 與 `agents.list[].tools`（以及 `agents.list[].tools.sandbox.tools`）。這讓你能在同一個 Gateway 閘道器中執行混合存取等級：

- 完整存取（個人代理程式）
- 唯讀工具 + 唯讀工作區（家庭／工作代理程式）
- 無檔案系統／殼層工具（公開代理程式）

範例、優先順序與疑難排解，請參閱 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)。

### 預設行為

- 映像檔：`openclaw-sandbox:bookworm-slim`
- 每個代理程式一個容器
- 代理程式工作區存取：`workspaceAccess: "none"`（預設）使用 `~/.openclaw/sandboxes`
  - `"ro"` 會將沙箱工作區保留在 `/workspace`，並將代理程式工作區以唯讀方式掛載於 `/agent`（停用 `write`/`edit`/`apply_patch`）
  - `"rw"` 會將代理程式工作區以讀／寫方式掛載於 `/workspace`
- 自動修剪：閒置 > 24 小時 或 存在時間 > 7 天
- 網路：預設為 `none`（若需要對外連線請明確啟用）
- 預設允許：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 預設拒絕：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 啟用沙箱隔離

如果你打算在 `setupCommand` 中安裝套件，請注意：

- 預設的 `docker.network` 為 `"none"`（無對外連線）。
- `readOnlyRoot: true` 會阻止套件安裝。
- `user` 必須為 root 才能進行 `apt-get`（省略 `user` 或設定為 `user: "0:0"`）。
  當 `setupCommand`（或 Docker 設定）變更時，OpenClaw 會自動重新建立容器，
  除非該容器**最近被使用**（約 5 分鐘內）。熱容器會記錄警告，並附上確切的 `openclaw sandbox recreate ...` 指令。

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
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
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

強化設定位於 `agents.defaults.sandbox.docker` 之下：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`。

多代理程式：可透過 `agents.list[].sandbox.{docker,browser,prune}.*` 為每個代理程式覆寫 `agents.defaults.sandbox.{docker,browser,prune}.*`
（當 `agents.defaults.sandbox.scope`／`agents.list[].sandbox.scope` 為 `"shared"` 時會被忽略）。

### 建置預設沙箱映像檔

```bash
scripts/sandbox-setup.sh
```

這會使用 `Dockerfile.sandbox` 建置 `openclaw-sandbox:bookworm-slim`。

### 沙箱通用映像檔（可選）

如果你想要包含常見建置工具（Node、Go、Rust 等）的沙箱映像檔，請建置通用映像檔：

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

要在沙箱中執行瀏覽器工具，請建置瀏覽器映像檔：

```bash
scripts/sandbox-browser-setup.sh
```

這會使用
`Dockerfile.sandbox-browser` 建置 `openclaw-sandbox-browser:bookworm-slim`。容器會以啟用 CDP 的 Chromium 執行，
並提供可選的 noVNC 觀察器（透過 Xvfb 的有頭模式）。

注意事項：

- 有頭（Xvfb）相較於無頭可降低被封鎖的機率。
- 仍可透過設定 `agents.defaults.sandbox.browser.headless=true` 使用無頭模式。
- 不需要完整的桌面環境（GNOME）；Xvfb 會提供顯示。

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

啟用後，代理程式會收到：

- 沙箱瀏覽器控制 URL（供 `browser` 工具使用）
- noVNC URL（若啟用且 headless=false）

請記得：如果你使用工具的允許清單，請加入 `browser`（並從拒絕清單移除），否則工具仍會被封鎖。
修剪規則（`agents.defaults.sandbox.prune`）也會套用到瀏覽器容器。

### 自訂沙箱映像檔

建置你自己的映像檔，並在設定中指向它：

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

### 工具政策（允許／拒絕）

- `deny` 的優先順序高於 `allow`。
- 若 `allow` 為空：除拒絕清單外，所有工具皆可使用。
- 若 `allow` 非空：僅 `allow` 中的工具可使用（扣除拒絕清單）。

### 修剪策略

兩個調整項：

- `prune.idleHours`：移除 X 小時內未使用的容器（0 = 停用）
- `prune.maxAgeDays`：移除存在超過 X 天的容器（0 = 停用）

範例：

- 保留忙碌中的工作階段，但限制存活時間：
  `idleHours: 24`、`maxAgeDays: 7`
- 永不修剪：
  `idleHours: 0`、`maxAgeDays: 0`

### 安全性注意事項

- 硬隔離僅適用於**工具**（exec/read/write/edit/apply_patch）。
- 僅主機工具（如 browser/camera/canvas）預設會被封鎖。
- 在沙箱中允許 `browser` **會破壞隔離**（瀏覽器會在主機上執行）。

## 疑難排解

- 找不到映像檔：請使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 建置，或設定 `agents.defaults.sandbox.docker.image`。
- 容器未執行：它會在每個工作階段需要時自動建立。
- 沙箱中的權限錯誤：將 `docker.user` 設為符合你掛載之工作區擁有權的 UID:GID（或對工作區資料夾執行 chown）。
- 找不到自訂工具：OpenClaw 以 `sh -lc`（登入殼層）執行命令，會載入 `/etc/profile` 並可能重設 PATH。請設定 `docker.env.PATH` 以在前置加入你的自訂工具路徑（例如 `/custom/bin:/usr/local/share/npm-global/bin`），或在 Dockerfile 中於 `/etc/profile.d/` 下新增腳本。
