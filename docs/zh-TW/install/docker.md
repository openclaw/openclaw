---
summary: Optional Docker-based setup and onboarding for OpenClaw
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
title: Docker
---

# Docker（可選）

Docker 是**可選的**。只有當你想要使用容器化的 gateway 或驗證 Docker 流程時才使用。

## Docker 適合我嗎？

- **是**：你想要一個獨立且可丟棄的 gateway 環境，或是在沒有本地安裝的主機上執行 OpenClaw。
- **否**：你在自己的機器上執行，只想要最快的開發迴圈。請改用一般安裝流程。
- **沙箱說明**：agent 沙箱也使用 Docker，但**不**需要整個 gateway 都在 Docker 中執行。詳見 [Sandboxing](/gateway/sandboxing)。

本指南涵蓋：

- 容器化 Gateway（完整 OpenClaw 在 Docker 中）
- 每次會話的 Agent 沙箱（主機 gateway + Docker 隔離的 agent 工具）

沙箱詳情：[Sandboxing](/gateway/sandboxing)

## 需求

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 至少 2 GB RAM 以建置映像檔（`pnpm install` 在 1 GB 主機上可能因 OOM 而被終止，退出碼 137）
- 足夠的磁碟空間存放映像檔與日誌
- 若在 VPS/公共主機上執行，請檢視
  [網路暴露的安全強化](/gateway/security#04-network-exposure-bind--port--firewall)，
  特別是 Docker `DOCKER-USER` 防火牆政策。

## 容器化 Gateway（Docker Compose）

### 快速開始（推薦）

<Note>
此處 Docker 預設假設使用綁定模式（`lan`/`loopback`），而非主機別名。請使用 `gateway.bind` 中的綁定模式值（例如 `lan` 或 `loopback`），而非像 `0.0.0.0` 或 `localhost` 這樣的主機別名。
</Note>

從專案根目錄執行：

```bash
./docker-setup.sh
```

此腳本：

- 本地建置 gateway 映像檔（或如果設定了 `OPENCLAW_IMAGE` 則拉取遠端映像檔）
- 執行入門精靈
- 顯示可選的提供者設定提示
- 透過 Docker Compose 啟動 gateway
- 產生 gateway token 並寫入 `.env`

可選環境變數：

- `OPENCLAW_IMAGE` — 使用遠端映像檔代替本地建置（例如 `ghcr.io/openclaw/openclaw:latest`）
- `OPENCLAW_DOCKER_APT_PACKAGES` — 在建置期間安裝額外的 apt 套件
- `OPENCLAW_EXTENSIONS` — 在建置時預先安裝擴充套件依賴（以空格分隔的擴充套件名稱，例如 `diagnostics-otel matrix`）
- `OPENCLAW_EXTRA_MOUNTS` — 新增額外的主機綁定掛載
- `OPENCLAW_HOME_VOLUME` — 將 `/home/node` 保存在命名卷中
- `OPENCLAW_SANDBOX` — 選擇啟用 Docker gateway 沙箱啟動。只有明確的真值才會啟用：`1`、`true`、`yes`、`on`
- `OPENCLAW_INSTALL_DOCKER_CLI` — 本地映像建置的建置參數傳遞（`1` 會在映像中安裝 Docker CLI）。當本地建置使用 `OPENCLAW_SANDBOX=1` 時，`docker-setup.sh` 會自動設定此參數。
- `OPENCLAW_DOCKER_SOCKET` — 覆寫 Docker socket 路徑（預設為 `DOCKER_HOST=unix://...` 路徑，否則為 `/var/run/docker.sock`）
- `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` — 緊急開關：允許受信任的私有網路
  `ws://` 目標用於 CLI/入門用戶端路徑（預設僅限迴圈回路）
- `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` — 禁用容器瀏覽器的強化標誌
  `--disable-3d-apis`、`--disable-software-rasterizer`、`--disable-gpu` 當您需要 WebGL/3D 相容性時使用。
- `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` — 在瀏覽器流程需要時保持擴充套件啟用（預設在沙箱瀏覽器中保持擴充套件停用）。
- `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>` — 設定 Chromium 渲染程序限制；設定為 `0` 可跳過此標誌並使用 Chromium 預設行為。

完成後：

- 在瀏覽器中開啟 `http://127.0.0.1:18789/`。
- 將 token 貼到控制介面（設定 → token）。
- 需要再次取得 URL？執行 `docker compose run --rm openclaw-cli dashboard --no-open`。

### 啟用 Docker gateway 的代理沙箱（選擇性）

`docker-setup.sh` 也可以為 Docker 部署啟動 `agents.defaults.sandbox.*`。

啟用方式：

```bash
export OPENCLAW_SANDBOX=1
./docker-setup.sh
```

自訂 socket 路徑（例如無 root 權限的 Docker）：

```bash
export OPENCLAW_SANDBOX=1
export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
./docker-setup.sh
```

注意事項：

- 腳本僅在沙箱先決條件通過後掛載 `docker.sock`。
- 如果無法完成沙箱設定，腳本會將 `agents.defaults.sandbox.mode` 重設為 `off`，以避免重複執行時出現過時或損壞的沙箱設定。
- 如果缺少 `Dockerfile.sandbox`，腳本會顯示警告並繼續；如有需要，請使用 `scripts/sandbox-setup.sh` 建置 `openclaw-sandbox:bookworm-slim`。
- 對於非本地的 `OPENCLAW_IMAGE` 值，映像必須已包含 Docker CLI 支援沙箱執行。

### 自動化/CI（非互動式，無 TTY 輸出雜訊）

對於腳本和 CI，使用 `-T` 禁用 Compose 的偽 TTY 分配：

```bash
docker compose run -T --rm openclaw-cli gateway probe
docker compose run -T --rm openclaw-cli devices list --json
```

如果您的自動化未匯出任何 Claude 會話變數，現在未設定的變數在 `docker-compose.yml` 中預設會解析為空值，以避免重複出現「變數未設定」的警告。

### 共享網路安全說明（CLI + gateway）

`openclaw-cli` 使用 `network_mode: "service:openclaw-gateway"`，因此 CLI 指令能在 Docker 中透過 `127.0.0.1` 穩定連接到 gateway。

請將此視為共享信任邊界：loopback 綁定並不代表這兩個容器之間的隔離。如果您需要更強的分離，請從獨立的容器或主機網路路徑執行指令，而非使用內建的 `openclaw-cli` 服務。

為降低 CLI 程序被入侵時的影響，compose 設定移除 `NET_RAW`/`NET_ADMIN`，並在 `openclaw-cli` 上啟用 `no-new-privileges`。

它會在主機上寫入 config/workspace：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上執行？請參考 [Hetzner (Docker VPS)](/install/hetzner)。

### 使用遠端映像（跳過本地建置）

官方預建映像發佈於：

- [GitHub Container Registry 套件](https://github.com/openclaw/openclaw/pkgs/container/openclaw)

請使用映像名稱 `ghcr.io/openclaw/openclaw`（非類似名稱的 Docker Hub 映像）。

常用標籤：

- `main` — 來自 `main` 的最新建置
- `<version>` — 發行標籤建置（例如 `2026.2.26`）
- `latest` — 最新穩定發行標籤

### 基底映像檔元資料

目前主要的 Docker 映像檔使用：

- `node:24-bookworm`

該 docker 映像檔現在會發布 OCI 基底映像檔註解（sha256 為範例，指向該標籤的固定多架構清單）：

- `org.opencontainers.image.base.name=docker.io/library/node:24-bookworm`
- `org.opencontainers.image.base.digest=sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b`
- `org.opencontainers.image.source=https://github.com/openclaw/openclaw`
- `org.opencontainers.image.url=https://openclaw.ai`
- `org.opencontainers.image.documentation=https://docs.openclaw.ai/install/docker`
- `org.opencontainers.image.licenses=MIT`
- `org.opencontainers.image.title=OpenClaw`
- `org.opencontainers.image.description=OpenClaw gateway and CLI runtime container image`
- `org.opencontainers.image.revision=<git-sha>`
- `org.opencontainers.image.version=<tag-or-main>`
- `org.opencontainers.image.created=<rfc3339 timestamp>`

參考資料：[OCI 映像檔註解](https://github.com/opencontainers/image-spec/blob/main/annotations.md)

發行背景：本儲存庫的標籤歷史已在 `v2026.2.22` 及更早的 2026 標籤中使用 Bookworm（例如 `v2026.2.21`、`v2026.2.9`）。

預設情況下，設定腳本會從原始碼建置映像檔。若要改為拉取預先建置的映像檔，請在執行腳本前設定 `OPENCLAW_IMAGE`：

```bash
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
./docker-setup.sh
```

腳本會偵測到 `OPENCLAW_IMAGE` 不是預設的 `openclaw:local`，並執行 `docker pull` 取代 `docker build`。其他部分（註冊、閘道啟動、token 產生）則維持相同運作。

`docker-setup.sh` 仍從儲存庫根目錄執行，因為它使用本地的 `docker-compose.yml` 和輔助檔案。`OPENCLAW_IMAGE` 跳過本地映像檔建置時間；但不取代 compose/setup 工作流程。

### Shell 輔助工具（選用）

為了更方便日常 Docker 管理，請安裝 `ClawDock`：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**加入你的 shell 設定檔（zsh）：**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

接著使用 `clawdock-start`、`clawdock-stop`、`clawdock-dashboard` 等指令。所有命令都執行 `clawdock-help`。

詳細請參考 [`ClawDock` Helper README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)。

### 手動流程（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：請從專案根目錄執行 `docker compose ...`。如果你啟用了
`OPENCLAW_EXTRA_MOUNTS` 或 `OPENCLAW_HOME_VOLUME`，設定腳本會寫入
`docker-compose.extra.yml`；在其他地方執行 Compose 時請包含它：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制介面 token + 配對（Docker）

如果你看到「unauthorized」或「disconnected (1008): pairing required」訊息，請取得最新的儀表板連結並在瀏覽器中批准裝置配對：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

更多細節請參考：[Dashboard](/web/dashboard)、[Devices](/cli/devices)。

### 額外掛載（可選）

如果你想將額外的主機目錄掛載到容器中，請在執行 `docker-setup.sh` 前設定 `OPENCLAW_EXTRA_MOUNTS`。此設定接受以逗號分隔的 Docker 綁定掛載清單，並會同時套用到 `openclaw-gateway` 和 `openclaw-cli`，透過產生 `docker-compose.extra.yml`。

範例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事項：

- 路徑必須與 macOS/Windows 上的 Docker Desktop 共享。
- 每個條目必須是 `source:target[:options]`，且不可有空格、製表符或換行。
- 如果你編輯了 `OPENCLAW_EXTRA_MOUNTS`，請重新執行 `docker-setup.sh` 以重新產生額外的 compose 檔案。
- `docker-compose.extra.yml` 是自動產生的，請勿手動編輯。

### 持久化整個容器的 home 目錄（可選）

如果你想讓 `/home/node` 在容器重建後仍然保留，請透過 `OPENCLAW_HOME_VOLUME` 設定命名卷。這會建立一個 Docker 卷並掛載到 `/home/node`，同時保留標準的 config/workspace 綁定掛載。此處請使用命名卷（而非綁定路徑）；若要使用綁定掛載，請使用 `OPENCLAW_EXTRA_MOUNTS`。

範例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

你也可以將此與額外掛載結合使用：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事項：

- 命名卷必須符合 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`。
- 如果你更改了 `OPENCLAW_HOME_VOLUME`，請重新執行 `docker-setup.sh` 以重新產生額外的 compose 檔案。
- 命名卷會持續存在，直到使用 `docker volume rm <name>` 移除為止。

### 安裝額外的 apt 套件（可選）

如果你需要在映像檔內安裝系統套件（例如建置工具或多媒體函式庫），請在執行 `docker-setup.sh` 前設定 `OPENCLAW_DOCKER_APT_PACKAGES`。這會在映像檔建置時安裝套件，因此即使容器被刪除，套件仍會保留。

範例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意事項：

- 這接受以空格分隔的 apt 套件名稱清單。
- 如果你更改了 `OPENCLAW_DOCKER_APT_PACKAGES`，請重新執行 `docker-setup.sh` 以重建映像檔。

### 預先安裝擴充套件依賴（可選）

擁有自己 `package.json` 的擴充套件（例如 `diagnostics-otel`、`matrix`、`msteams`）會在首次載入時安裝其 npm 依賴。若要將這些依賴預先打包進映像檔，請在執行 `docker-setup.sh` 前設定 `OPENCLAW_EXTENSIONS`：

```bash
export OPENCLAW_EXTENSIONS="diagnostics-otel matrix"
./docker-setup.sh
```

或直接在建置時：

```bash
docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel matrix" .
```

注意事項：

- 這接受以空格分隔的擴充套件目錄名稱清單（位於 `extensions/` 下）。
- 只有擁有 `package.json` 的擴充套件會受到影響；沒有的輕量級外掛會被忽略。
- 如果你更改了 `OPENCLAW_EXTENSIONS`，請重新執行 `docker-setup.sh` 以重建映像檔。

### 進階使用者 / 全功能容器（選擇性啟用）

預設的 Docker 映像檔是以 **安全優先** 為原則，並以非 root 的 `node` 使用者身份執行。這樣可以減少攻擊面，但也代表：

- 執行時無法安裝系統套件
- 預設沒有 Homebrew
- 沒有內建 Chromium/Playwright 瀏覽器

如果你想要更完整功能的容器，可以使用以下選擇性設定：

1. **持久化 `/home/node`**，讓瀏覽器下載和工具快取得以保留：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **將系統依賴打包進映像檔**（可重複且持久）：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **安裝 Playwright 瀏覽器時不使用 `npx`**（避免 npm 覆寫衝突）：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

如果你需要 Playwright 安裝系統相依套件，請在重建映像時使用 `OPENCLAW_DOCKER_APT_PACKAGES`，而非在執行時使用 `--with-deps`。

4. **持久化 Playwright 瀏覽器下載檔案**：

- 在 `docker-compose.yml` 中設定 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
- 確保透過 `OPENCLAW_HOME_VOLUME` 持久化 `/home/node`，或是透過 `OPENCLAW_EXTRA_MOUNTS` 掛載 `/home/node/.cache/ms-playwright`。

### 權限問題 + EACCES

映像以 `node`（uid 1000）身份執行。如果你在 `/home/node/.openclaw` 遇到權限錯誤，請確認你的主機綁定掛載目錄是屬於 uid 1000。

範例（Linux 主機）：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

如果你為了方便選擇以 root 身份執行，即表示你接受安全性上的權衡。

### 更快的重建（推薦）

為了加快重建速度，請將 Dockerfile 排序，使相依層能被快取。這樣除非鎖定檔改變，否則可避免重新執行 `pnpm install`：

dockerfile
FROM node:24-bookworm

# 安裝 Bun（建置腳本所需）

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# 快取依賴，除非套件元資料有變更

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

### 頻道設定（選用）

使用 CLI 容器來設定頻道，設定完成後如有需要請重新啟動 gateway。

WhatsApp（QR）：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram（bot token）：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord（bot token）：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

文件： [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

### OpenAI Codex OAuth（無頭 Docker）

如果你在精靈中選擇 OpenAI Codex OAuth，會開啟一個瀏覽器 URL 並嘗試在 `http://127.0.0.1:1455/auth/callback` 捕捉回調。在 Docker 或無頭環境中，該回調可能會顯示瀏覽器錯誤。請複製你最終導向的完整重定向 URL，並貼回精靈中以完成授權。

### 健康檢查

容器探針端點（不需驗證）：

```bash
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:18789/readyz
```

別名：`/health` 和 `/ready`。

`/healthz` 是用來檢查「閘道程序是否啟動」的淺層活躍探針。`/readyz` 在啟動寬限期內保持準備狀態，只有在寬限期結束後仍有必要管理的頻道未連線或之後斷線時，才會變成 `503`。

Docker 映像內建 `HEALTHCHECK`，會在背景持續 ping `/healthz`。簡單來說：Docker 持續檢查 OpenClaw 是否仍有回應。如果檢查持續失敗，Docker 會將容器標記為 `unhealthy`，並且編排系統（Docker Compose 重啟策略、Swarm、Kubernetes 等）可以自動重啟或替換容器。

已驗證的深度健康快照（閘道 + 頻道）：

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 煙霧測試（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QR 匯入煙霧測試（Docker）

```bash
pnpm test:docker:qr
```

### LAN 與 loopback（Docker Compose）

`docker-setup.sh` 預設 `OPENCLAW_GATEWAY_BIND=lan`，因此主機存取 `http://127.0.0.1:18789` 可透過 Docker 端口映射正常運作。

- `lan`（預設）：主機瀏覽器與主機 CLI 可連接已發布的 gateway 端口。
- `loopback`：只有容器網路命名空間內的程序能直接連接 gateway；主機發布的端口存取可能會失敗。

設定腳本在加入後也會將 `gateway.mode=local` 鎖定，使 Docker CLI 命令預設以本地 loopback 為目標。

舊版設定說明：請使用 `gateway.bind` 中的 bind 模式值（`lan` / `loopback` / `custom` / `tailnet` / `auto`），而非主機別名（`0.0.0.0`、`127.0.0.1`、`localhost`、`::`、`::1`）。

如果你從 Docker CLI 命令看到 `Gateway target: ws://172.x.x.x:18789` 或重複的 `pairing required` 錯誤，請執行：

```bash
docker compose run --rm openclaw-cli config set gateway.mode local
docker compose run --rm openclaw-cli config set gateway.bind lan
docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
```

### 注意事項

- Gateway 綁定預設為 `lan` 供容器使用（`OPENCLAW_GATEWAY_BIND`）。
- Dockerfile CMD 使用 `--allow-unconfigured`；掛載的設定若是 `gateway.mode` 而非 `local` 仍會啟動。可覆寫 CMD 以強制執行保護。
- gateway 容器是會話的真實來源（`~/.openclaw/agents/<agentId>/sessions/`）。

### 儲存模型

- **持久化主機資料：** Docker Compose 將 `OPENCLAW_CONFIG_DIR` 綁定掛載到 `/home/node/.openclaw`，`OPENCLAW_WORKSPACE_DIR` 綁定掛載到 `/home/node/.openclaw/workspace`，因此這些路徑在容器替換時仍會保留。
- **臨時沙盒 tmpfs：** 啟用 `agents.defaults.sandbox` 時，沙盒容器會使用 `tmpfs` 來存放 `/tmp`、`/var/tmp` 和 `/run`。這些掛載點與頂層 Compose 堆疊分開，沙盒容器移除時也會消失。
- **磁碟成長熱點：** 注意 `media/`、`agents/<agentId>/sessions/sessions.json`、轉錄 JSONL 檔案、`cron/runs/*.jsonl`，以及 `/tmp/openclaw/`（或你設定的 `logging.file`）下的滾動檔案日誌。如果你也在 Docker 外執行 macOS 應用程式，其服務日誌則是另外分開：`~/.openclaw/logs/gateway.log`、`~/.openclaw/logs/gateway.err.log` 和 `/tmp/openclaw/openclaw-gateway.log`。

## Agent 沙盒（主機 gateway + Docker 工具）

深入了解：[Sandboxing](/gateway/sandboxing)

### 功能說明

當 `agents.defaults.sandbox` 啟用時，**非主要會話**會在 Docker 容器內執行工具。gateway 保持在你的主機上，但工具執行是隔離的：

- 預設範圍：`"agent"`（每個代理一個容器 + 工作區）
- 範圍：`"session"` 用於每次會話隔離
- 每個範圍的工作區資料夾掛載於 `/workspace`
- 選用代理工作區存取 (`agents.defaults.sandbox.workspaceAccess`)
- 允許/拒絕工具政策（拒絕優先）
- 傳入媒體會被複製到啟用中的沙盒工作區 (`media/inbound/*`)，以便工具讀取（使用 `workspaceAccess: "rw"` 時，會放在代理工作區）

警告：`scope: "shared"` 會停用跨會話隔離。所有會話共用
同一個容器和工作區。

### 每代理沙盒設定檔（多代理）

如果您使用多代理路由，每個代理可以覆寫沙盒與工具設定：
`agents.list[].sandbox` 和 `agents.list[].tools`（加上 `agents.list[].tools.sandbox.tools`）。這讓您能在同一個閘道中
執行混合存取權限：

- 完全存取（個人代理）
- 只讀工具 + 只讀工作區（家庭/工作代理）
- 無檔案系統/Shell 工具（公共代理）

請參考 [多代理沙盒與工具](/tools/multi-agent-sandbox-tools) 了解範例、
優先權與故障排除。

### 預設行為

- 映像檔：`openclaw-sandbox:bookworm-slim`
- 每個代理一個容器
- 代理工作區存取：`workspaceAccess: "none"`（預設）使用 `~/.openclaw/sandboxes`
  - `"ro"` 將沙盒工作區保留在 `/workspace`，並以唯讀方式掛載代理工作區於 `/agent`（停用 `write`/`edit`/`apply_patch`）
  - `"rw"` 以讀寫方式掛載代理工作區於 `/workspace`
- 自動清理：閒置超過 24 小時或存在超過 7 天
- 網路：預設為 `none`（需要外發時需明確選擇）
  - `host` 被封鎖。
  - `container:<id>` 預設被封鎖（有命名空間連接風險）。
- 預設允許：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 預設拒絕：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 啟用沙盒功能

如果您計畫在 `setupCommand` 安裝套件，請注意：

- 預設 `docker.network` 為 `"none"`（無外發）。
- `docker.network: "host"` 被封鎖。
- `docker.network: "container:<id>"` 預設被封鎖。
- 緊急覆寫：`agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`。
- `readOnlyRoot: true` 阻擋套件安裝。
- `user` 必須是 root 權限以執行 `apt-get`（省略 `user` 或設定 `user: "0:0"`）。
  OpenClaw 在 `setupCommand`（或 docker 設定）變更時會自動重建容器，
  除非該容器是**近期使用過**（約 5 分鐘內）。熱容器會記錄包含精確 `openclaw sandbox recreate ...` 指令的警告。

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

強化設定位於 `agents.defaults.sandbox.docker`：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`、
`dangerouslyAllowContainerNamespaceJoin`（僅限緊急覆寫）。

多代理：可透過 `agents.list[].sandbox.{docker,browser,prune}.*` 針對每個代理覆寫 `agents.defaults.sandbox.{docker,browser,prune}.*`
（當 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 為 `"shared"` 時忽略）。

### 建置預設沙盒映像檔

```bash
scripts/sandbox-setup.sh
```

這會使用 `Dockerfile.sandbox` 來建置 `openclaw-sandbox:bookworm-slim`。

### 沙盒通用映像檔（可選）

如果你想要一個包含常用建置工具（Node、Go、Rust 等）的沙盒映像檔，請建置通用映像檔：

```bash
scripts/sandbox-common-setup.sh
```

這會建置 `openclaw-sandbox-common:bookworm-slim`。使用方式如下：

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### 沙盒瀏覽器映像檔

要在沙盒中執行瀏覽器工具，請建置瀏覽器映像檔：

```bash
scripts/sandbox-browser-setup.sh
```

這會使用 `Dockerfile.sandbox-browser` 來建置 `openclaw-sandbox-browser:bookworm-slim`。容器會啟動啟用 CDP 的 Chromium，並可選擇啟用 noVNC 觀察者（透過 Xvfb 以有頭模式執行）。

注意事項：

- 有頭模式（Xvfb）相較無頭模式能減少被機器人封鎖的機率。
- 仍可透過設定 `agents.defaults.sandbox.browser.headless=true` 使用無頭模式。
- 不需要完整桌面環境（GNOME）；Xvfb 提供顯示功能。
- 瀏覽器容器預設使用專用 Docker 網路 (`openclaw-sandbox-browser`)，而非全域 `bridge`。
- 可選的 `agents.defaults.sandbox.browser.cdpSourceRange` 透過 CIDR（例如 `172.21.0.1/32`）限制容器邊界的 CDP 入口流量。
- noVNC 觀察者預設有密碼保護；OpenClaw 提供短期有效的觀察者 token URL，該 URL 會載入本地啟動頁面，且密碼存放於 URL 片段（而非 URL 查詢參數）。
- 瀏覽器容器啟動預設值針對共用/容器工作負載採取保守設定，包括：
  - `--remote-debugging-address=127.0.0.1`
  - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
  - `--user-data-dir=${HOME}/.chrome`
  - `--no-first-run`
  - `--no-default-browser-check`
  - `--disable-3d-apis`
  - `--disable-software-rasterizer`
  - `--disable-gpu`
  - `--disable-dev-shm-usage`
  - `--disable-background-networking`
  - `--disable-features=TranslateUI`
  - `--disable-breakpad`
  - `--disable-crash-reporter`
  - `--metrics-recording-only`
  - `--renderer-process-limit=2`
  - `--no-zygote`
  - `--disable-extensions`
  - 若設定了 `agents.defaults.sandbox.browser.noSandbox`，則會同時附加 `--no-sandbox` 和 `--disable-setuid-sandbox`。
  - 上述三個圖形強化旗標為可選專案。若你的工作負載需要 WebGL/3D，請設定 `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0`，以在不啟用 `--disable-3d-apis`、`--disable-software-rasterizer` 和 `--disable-gpu` 的情況下執行。
  - 擴充功能行為由 `--disable-extensions` 控制，並可透過 `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` 禁用（啟用擴充功能），適用於依賴擴充功能的頁面或大量使用擴充功能的工作流程。
  - `--renderer-process-limit=2` 也可透過 `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT` 進行設定；若需調整瀏覽器併發數，請設定 `0` 讓 Chromium 選擇其預設的程序限制。

預設值會在內建映像檔中自動套用。若你需要不同的 Chromium 旗標，請使用自訂瀏覽器映像檔並提供自己的 entrypoint。

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

啟用後，代理程式會接收：

- 一個沙盒瀏覽器控制 URL（用於 `browser` 工具）
- 一個 noVNC URL（如果啟用且 headless=false）

請記得：如果你使用工具允許清單，請加入 `browser`（並從拒絕清單中移除），否則該工具會被封鎖。
修剪規則（`agents.defaults.sandbox.prune`）同樣適用於瀏覽器容器。

### 自訂沙盒映像檔

自行建置映像檔並將設定指向它：

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

### 工具政策（允許/拒絕）

- `deny` 優先於 `allow`。
- 如果 `allow` 為空：所有工具（拒絕除外）皆可使用。
- 如果 `allow` 非空：僅允許 `allow` 中的工具（扣除拒絕清單）。

### 修剪策略

兩個調整參數：

- `prune.idleHours`：移除超過 X 小時未使用的容器（0 = 停用）
- `prune.maxAgeDays`：移除超過 X 天的舊容器（0 = 停用）

- 保持忙碌的 session 但限制存活時間：
  `idleHours: 24`, `maxAgeDays: 7`
- 永不清除：
  `idleHours: 0`, `maxAgeDays: 0`

### 安全性說明

- 硬性隔離僅適用於 **工具**（exec/read/write/edit/apply_patch）。
- 僅限主機的工具如瀏覽器/相機/畫布預設被封鎖。
- 在沙盒中允許 `browser` **會破壞隔離**（瀏覽器會在主機上執行）。

## 疑難排解

- 映像檔缺失：使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 建置或設定 `agents.defaults.sandbox.docker.image`。
- 容器未執行：會依需求自動為每個 session 建立。
- 沙盒中權限錯誤：將 `docker.user` 設為與你掛載的工作目錄擁有者相符的 UID:GID（或對工作目錄執行 chown）。
- 找不到自訂工具：OpenClaw 以 `sh -lc`（登入 shell）執行指令，會載入 `/etc/profile` 並可能重設 PATH。設定 `docker.env.PATH` 以將你的自訂工具路徑（例如 `/custom/bin:/usr/local/share/npm-global/bin`）置於前面，或在 Dockerfile 中於 `/etc/profile.d/` 下新增腳本。
