---
read_when:
  - 你想要容器化的 Gateway 网关而不是本地安装
  - 你正在验证 Docker 流程
summary: OpenClaw 的可选 Docker 设置和新手引导
title: Docker
x-i18n:
  generated_at: "2026-02-03T07:51:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bd823e49b6ce76fe1136a42bf48f436b316ed1cd2f9612e3f4919f1e6b2cdee9
  source_path: install/docker.md
  workflow: 15
---

# Docker（可选）

Docker 是**可选的**。仅当你想要容器化的 Gateway 网关或验证 Docker 流程时才使用它。

## Docker 适合我吗？

- **是**：你想要一个隔离的、可丢弃的 Gateway 网关环境，或在没有本地安装的主机上运行 OpenClaw。
- **否**：你在自己的机器上运行，只想要最快的开发循环。请改用正常的安装流程。
- **沙箱注意事项**：智能体沙箱隔离也使用 Docker，但它**不需要**完整的 Gateway 网关在 Docker 中运行。参阅[沙箱隔离](/gateway/sandboxing)。

本指南涵盖：

- 容器化 Gateway 网关（完整的 OpenClaw 在 Docker 中）
- 每会话智能体沙箱（主机 Gateway 网关 + Docker 隔离的智能体工具）

沙箱隔离详情：[沙箱隔离](/gateway/sandboxing)

## 要求

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 足够的磁盘空间用于镜像 + 日志

## 容器化 Gateway 网关（Docker Compose）

### 快速开始（推荐）

从仓库根目录：

```bash
./docker-setup.sh
```

此脚本：

- 构建 Gateway 网关镜像
- 运行新手引导向导
- 打印可选的提供商设置提示
- 通过 Docker Compose 启动 Gateway 网关
- 生成 Gateway 网关令牌并写入 `.env`

可选环境变量：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在构建期间安装额外的 apt 包
- `OPENCLAW_EXTRA_MOUNTS` — 添加额外的主机绑定挂载
- `OPENCLAW_HOME_VOLUME` — 在命名卷中持久化 `/home/node`

完成后：

- 在浏览器中打开 `http://127.0.0.1:18789/`。
- 将令牌粘贴到控制 UI（设置 → token）。
- 需要再次获取带令牌的 URL？运行 `docker compose run --rm openclaw-cli dashboard --no-open`。

它在主机上写入配置/工作区：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上运行？参阅 [Hetzner（Docker VPS）](/platforms/hetzner)。

### 手动流程（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

注意：从仓库根目录运行 `docker compose ...`。如果你启用了 `OPENCLAW_EXTRA_MOUNTS` 或 `OPENCLAW_HOME_VOLUME`，设置脚本会写入 `docker-compose.extra.yml`；在其他地方运行 Compose 时包含它：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制 UI 令牌 + 配对（Docker）

如果你看到"unauthorized"或"disconnected (1008): pairing required"，获取新的仪表板链接并批准浏览器设备：

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

更多详情：[仪表板](/web/dashboard)，[设备](/cli/devices)。

### 额外挂载（可选）

如果你想将额外的主机目录挂载到容器中，在运行 `docker-setup.sh` 之前设置 `OPENCLAW_EXTRA_MOUNTS`。这接受逗号分隔的 Docker 绑定挂载列表，并通过生成 `docker-compose.extra.yml` 将它们应用到 `openclaw-gateway` 和 `openclaw-cli`。

示例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 路径必须在 macOS/Windows 上与 Docker Desktop 共享。
- 如果你编辑 `OPENCLAW_EXTRA_MOUNTS`，重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- `docker-compose.extra.yml` 是生成的。不要手动编辑它。

### 持久化整个容器 home（可选）

如果你想让 `/home/node` 在容器重建后持久化，通过 `OPENCLAW_HOME_VOLUME` 设置一个命名卷。这会创建一个 Docker 卷并将其挂载到 `/home/node`，同时保持标准的配置/工作区绑定挂载。这里使用命名卷（不是绑定路径）；对于绑定挂载，使用 `OPENCLAW_EXTRA_MOUNTS`。

示例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

你可以将其与额外挂载结合使用：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 如果你更改 `OPENCLAW_HOME_VOLUME`，重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- 命名卷会持久化直到使用 `docker volume rm <name>` 删除。

### 安装额外的 apt 包（可选）

如果你需要镜像内的系统包（例如构建工具或媒体库），在运行 `docker-setup.sh` 之前设置 `OPENCLAW_DOCKER_APT_PACKAGES`。这会在镜像构建期间安装包，因此即使容器被删除它们也会持久化。

示例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意：

- 这接受空格分隔的 apt 包名称列表。
- 如果你更改 `OPENCLAW_DOCKER_APT_PACKAGES`，重新运行 `docker-setup.sh` 以重建镜像。

### 高级用户/功能完整的容器（选择加入）

默认的 Docker 镜像是**安全优先**的，以非 root 的 `node` 用户运行。这保持了较小的攻击面，但这意味着：

- 运行时无法安装系统包
- 默认没有 Homebrew
- 没有捆绑的 Chromium/Playwright 浏览器

如果你想要功能更完整的容器，使用这些选择加入选项：

1. **持久化 `/home/node`** 以便浏览器下载和工具缓存能够保留：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **将系统依赖烘焙到镜像中**（可重复 + 持久化）：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **不使用 `npx` 安装 Playwright 浏览器**（避免 npm 覆盖冲突）：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

如果你需要 Playwright 安装系统依赖，使用 `OPENCLAW_DOCKER_APT_PACKAGES` 重建镜像，而不是在运行时使用 `--with-deps`。

4. **持久化 Playwright 浏览器下载**：

- 在 `docker-compose.yml` 中设置 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
- 确保 `/home/node` 通过 `OPENCLAW_HOME_VOLUME` 持久化，或通过 `OPENCLAW_EXTRA_MOUNTS` 挂载 `/home/node/.cache/ms-playwright`。

### 权限 + EACCES

镜像以 `node`（uid 1000）运行。如果你在 `/home/node/.openclaw` 上看到权限错误，确保你的主机绑定挂载由 uid 1000 拥有。

示例（Linux 主机）：

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

如果你选择以 root 运行以方便使用，你接受了安全权衡。

### 更快的重建（推荐）

要加速重建，排序你的 Dockerfile 以便依赖层被缓存。这避免了除非锁文件更改否则重新运行 `pnpm install`：

```dockerfile
FROM node:22-bookworm

# 安装 Bun（构建脚本需要）
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# 缓存依赖，除非包元数据更改
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

### 渠道设置（可选）

使用 CLI 容器配置渠道，然后在需要时重启 Gateway 网关。

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

文档：[WhatsApp](/channels/whatsapp)，[Telegram](/channels/telegram)，[Discord](/channels/discord)

### OpenAI Codex OAuth（无头 Docker）

如果你在向导中选择 OpenAI Codex OAuth，它会打开浏览器 URL 并尝试在 `http://127.0.0.1:1455/auth/callback` 捕获回调。在 Docker 或无头设置中，该回调可能显示浏览器错误。复制你到达的完整重定向 URL 并将其粘贴回向导以完成认证。

### 健康检查

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 冒烟测试（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QR 导入冒烟测试（Docker）

```bash
pnpm test:docker:qr
```

### 注意

- Gateway 网关绑定默认为 `lan` 用于容器使用。
- Dockerfile CMD 使用 `--allow-unconfigured`；挂载的配置如果 `gateway.mode` 不是 `local` 仍会启动。覆盖 CMD 以强制执行检查。
- Gateway 网关容器是会话的真实来源（`~/.openclaw/agents/<agentId>/sessions/`）。

## 智能体沙箱（主机 Gateway 网关 + Docker 工具）

深入了解：[沙箱隔离](/gateway/sandboxing)

### 它做什么

当启用 `agents.defaults.sandbox` 时，**非主会话**在 Docker 容器内运行工具。Gateway 网关保持在你的主机上，但工具执行是隔离的：

- scope：默认为 `"agent"`（每个智能体一个容器 + 工作区）
- scope：`"session"` 用于每会话隔离
- 每作用域工作区文件夹挂载在 `/workspace`
- 可选的智能体工作区访问（`agents.defaults.sandbox.workspaceAccess`）
- 允许/拒绝工具策略（拒绝优先）
- 入站媒体被复制到活动沙箱工作区（`media/inbound/*`），以便工具可以读取它（使用 `workspaceAccess: "rw"` 时，这会落在智能体工作区中）

警告：`scope: "shared"` 禁用跨会话隔离。所有会话共享一个容器和一个工作区。

### 每智能体沙箱配置文件（多智能体）

如果你使用多智能体路由，每个智能体可以覆盖沙箱 + 工具设置：`agents.list[].sandbox` 和 `agents.list[].tools`（加上 `agents.list[].tools.sandbox.tools`）。这让你可以在一个 Gateway 网关中运行混合访问级别：

- 完全访问（个人智能体）
- 只读工具 + 只读工作区（家庭/工作智能体）
- 无文件系统/shell 工具（公共智能体）

参阅[多智能体沙箱与工具](/multi-agent-sandbox-tools)了解示例、优先级和故障排除。

### 默认行为

- 镜像：`openclaw-sandbox:bookworm-slim`
- 每个智能体一个容器
- 智能体工作区访问：`workspaceAccess: "none"`（默认）使用 `~/.openclaw/sandboxes`
  - `"ro"` 保持沙箱工作区在 `/workspace` 并将智能体工作区只读挂载在 `/agent`（禁用 `write`/`edit`/`apply_patch`）
  - `"rw"` 将智能体工作区读写挂载在 `/workspace`
- 自动清理：空闲 > 24h 或 年龄 > 7d
- 网络：默认为 `none`（如果需要出站则明确选择加入）
- 默认允许：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 默认拒绝：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 启用沙箱隔离

如果你计划在 `setupCommand` 中安装包，请注意：

- 默认 `docker.network` 是 `"none"`（无出站）。
- `readOnlyRoot: true` 阻止包安装。
- `user` 必须是 root 才能运行 `apt-get`（省略 `user` 或设置 `user: "0:0"`）。
  当 `setupCommand`（或 docker 配置）更改时，OpenClaw 会自动重建容器，除非容器是**最近使用的**（在约 5 分钟内）。热容器会记录警告，包含确切的 `openclaw sandbox recreate ...` 命令。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared（默认为 agent）
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
          idleHours: 24, // 0 禁用空闲清理
          maxAgeDays: 7, // 0 禁用最大年龄清理
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

加固选项位于 `agents.defaults.sandbox.docker` 下：`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`。

多智能体：通过 `agents.list[].sandbox.{docker,browser,prune}.*` 按智能体覆盖 `agents.defaults.sandbox.{docker,browser,prune}.*`（当 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 是 `"shared"` 时忽略）。

### 构建默认沙箱镜像

```bash
scripts/sandbox-setup.sh
```

这使用 `Dockerfile.sandbox` 构建 `openclaw-sandbox:bookworm-slim`。

### 沙箱通用镜像（可选）

如果你想要一个带有常见构建工具（Node、Go、Rust 等）的沙箱镜像，构建通用镜像：

```bash
scripts/sandbox-common-setup.sh
```

这构建 `openclaw-sandbox-common:bookworm-slim`。要使用它：

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### 沙箱浏览器镜像

要在沙箱内运行浏览器工具，构建浏览器镜像：

```bash
scripts/sandbox-browser-setup.sh
```

这使用 `Dockerfile.sandbox-browser` 构建 `openclaw-sandbox-browser:bookworm-slim`。容器运行启用 CDP 的 Chromium 和可选的 noVNC 观察器（通过 Xvfb 有头）。

注意：

- 有头（Xvfb）比无头减少机器人阻止。
- 通过设置 `agents.defaults.sandbox.browser.headless=true` 仍然可以使用无头模式。
- 不需要完整的桌面环境（GNOME）；Xvfb 提供显示。

使用配置：

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

自定义浏览器镜像：

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

启用后，智能体接收：

- 沙箱浏览器控制 URL（用于 `browser` 工具）
- noVNC URL（如果启用且 headless=false）

记住：如果你使用工具允许列表，添加 `browser`（并从拒绝中移除它）否则工具仍然被阻止。
清理规则（`agents.defaults.sandbox.prune`）也适用于浏览器容器。

### 自定义沙箱镜像

构建你自己的镜像并将配置指向它：

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

### 工具策略（允许/拒绝）

- `deny` 优先于 `allow`。
- 如果 `allow` 为空：所有工具（除了 deny）都可用。
- 如果 `allow` 非空：只有 `allow` 中的工具可用（减去 deny）。

### 清理策略

两个选项：

- `prune.idleHours`：移除 X 小时未使用的容器（0 = 禁用）
- `prune.maxAgeDays`：移除超过 X 天的容器（0 = 禁用）

示例：

- 保留繁忙会话但限制生命周期：
  `idleHours: 24`、`maxAgeDays: 7`
- 永不清理：
  `idleHours: 0`、`maxAgeDays: 0`

### 安全注意事项

- 硬隔离仅适用于**工具**（exec/read/write/edit/apply_patch）。
- 仅主机工具如 browser/camera/canvas 默认被阻止。
- 在沙箱中允许 `browser` **会破坏隔离**（浏览器在主机上运行）。

## 故障排除

- 镜像缺失：使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 构建或设置 `agents.defaults.sandbox.docker.image`。
- 容器未运行：它会按需为每个会话自动创建。
- 沙箱中的权限错误：将 `docker.user` 设置为与你挂载的工作区所有权匹配的 UID:GID（或 chown 工作区文件夹）。
- 找不到自定义工具：OpenClaw 使用 `sh -lc`（登录 shell）运行命令，这会 source `/etc/profile` 并可能重置 PATH。设置 `docker.env.PATH` 以在前面添加你的自定义工具路径（例如 `/custom/bin:/usr/local/share/npm-global/bin`），或在你的 Dockerfile 中在 `/etc/profile.d/` 下添加脚本。
