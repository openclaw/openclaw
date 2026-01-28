---
read_when:
  - 你想要容器化的 Gateway网关而非本地安装
  - 你正在验证 Docker 流程
summary: 可选的基于 Docker 的 OpenClaw 设置和新手引导
title: Docker
x-i18n:
  generated_at: "2026-02-01T21:07:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 781dd01ca99a2101f622f03162eb1776079c3c444f54c5a054d6816ec203e2f2
  source_path: install/docker.md
  workflow: 14
---

# Docker（可选）

Docker 是**可选的**。仅在你需要容器化 Gateway网关或验证 Docker 流程时使用。

## Docker 适合我吗？

- **适合**：你需要一个隔离的、可随时销毁的 Gateway网关环境，或者想在无需本地安装的主机上运行 OpenClaw。
- **不适合**：你在自己的机器上运行，只想要最快的开发循环。请改用常规安装流程。
- **沙箱说明**：智能体沙箱也使用 Docker，但它**不需要**完整的 Gateway网关运行在 Docker 中。详见 [沙箱](/gateway/sandboxing)。

本指南涵盖：

- 容器化 Gateway网关（完整的 OpenClaw 运行在 Docker 中）
- 按会话的智能体沙箱（主机 Gateway网关 + Docker 隔离的智能体工具）

沙箱详情：[沙箱](/gateway/sandboxing)

## 前置要求

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 足够的磁盘空间用于镜像和日志

## 容器化 Gateway网关（Docker Compose）

### 快速开始（推荐）

在仓库根目录运行：

```bash
./docker-setup.sh
```

该脚本会：

- 构建 Gateway网关镜像
- 运行新手引导向导
- 打印可选的提供商设置提示
- 通过 Docker Compose 启动 Gateway网关
- 生成 Gateway网关令牌并写入 `.env`

可选环境变量：

- `OPENCLAW_DOCKER_APT_PACKAGES` — 在构建期间安装额外的 apt 软件包
- `OPENCLAW_EXTRA_MOUNTS` — 添加额外的主机绑定挂载
- `OPENCLAW_HOME_VOLUME` — 将 `/home/node` 持久化到命名卷

完成后：

- 在浏览器中打开 `http://127.0.0.1:18789/`。
- 在控制界面中粘贴令牌（设置 → 令牌）。

配置和工作区写入主机：

- `~/.openclaw/`
- `~/.openclaw/workspace`

在 VPS 上运行？参见 [Hetzner（Docker VPS）](/platforms/hetzner)。

### 手动流程（compose）

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

### 额外挂载（可选）

如果你想将额外的主机目录挂载到容器中，请在运行 `docker-setup.sh` 之前设置 `OPENCLAW_EXTRA_MOUNTS`。该变量接受逗号分隔的 Docker 绑定挂载列表，并通过生成 `docker-compose.extra.yml` 将其应用到 `openclaw-gateway` 和 `openclaw-cli`。

示例：

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事项：

- 在 macOS/Windows 上，路径必须与 Docker Desktop 共享。
- 如果修改了 `OPENCLAW_EXTRA_MOUNTS`，请重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- `docker-compose.extra.yml` 是自动生成的。请勿手动编辑。

### 持久化整个容器 home 目录（可选）

如果你希望 `/home/node` 在容器重建后持久保留，请通过 `OPENCLAW_HOME_VOLUME` 设置命名卷。这会创建一个 Docker 卷并挂载到 `/home/node`，同时保留标准的配置/工作区绑定挂载。此处请使用命名卷（而非绑定路径）；绑定挂载请使用 `OPENCLAW_EXTRA_MOUNTS`。

示例：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

可以与额外挂载组合使用：

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意事项：

- 如果修改了 `OPENCLAW_HOME_VOLUME`，请重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- 命名卷会一直保留，直到通过 `docker volume rm <name>` 删除。

### 安装额外的 apt 软件包（可选）

如果你需要在镜像中安装系统软件包（例如构建工具或媒体库），请在运行 `docker-setup.sh` 之前设置 `OPENCLAW_DOCKER_APT_PACKAGES`。这会在镜像构建期间安装软件包，因此即使容器被删除也会保留。

示例：

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意事项：

- 该变量接受以空格分隔的 apt 软件包名称列表。
- 如果修改了 `OPENCLAW_DOCKER_APT_PACKAGES`，请重新运行 `docker-setup.sh` 以重建镜像。

### 加速重建（推荐）

为加速重建，请调整 Dockerfile 中的顺序以利用依赖层缓存。这样只有在锁文件变更时才会重新运行 `pnpm install`：

```dockerfile
FROM node:22-bookworm

# 安装 Bun（构建脚本需要）
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# 除非包元数据变更，否则缓存依赖
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

使用 CLI 容器配置渠道，然后根据需要重启 Gateway网关。

WhatsApp（二维码）：

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram（机器人令牌）：

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord（机器人令牌）：

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

文档：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

### 健康检查

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### 端到端冒烟测试（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### 二维码导入冒烟测试（Docker）

```bash
pnpm test:docker:qr
```

### 注意事项

- Gateway网关绑定默认设为 `lan` 以适配容器使用。
- Gateway网关容器是会话的权威来源（`~/.openclaw/agents/<agentId>/sessions/`）。

## 智能体沙箱（主机 Gateway网关 + Docker 工具）

深入了解：[沙箱](/gateway/sandboxing)

### 功能说明

当启用 `agents.defaults.sandbox` 时，**非 main 会话**会在 Docker 容器内运行工具。Gateway网关仍在主机上运行，但工具执行是隔离的：

- 作用域：默认为 `"agent"`（每个智能体一个容器 + 工作区）
- 作用域：`"session"` 用于按会话隔离
- 按作用域的工作区文件夹挂载到 `/workspace`
- 可选的智能体工作区访问（`agents.defaults.sandbox.workspaceAccess`）
- 允许/拒绝工具策略（拒绝优先）
- 入站媒体会复制到活动沙箱工作区（`media/inbound/*`），以便工具可以读取（使用 `workspaceAccess: "rw"` 时，媒体会落入智能体工作区）

警告：`scope: "shared"` 会禁用跨会话隔离。所有会话共享一个容器和一个工作区。

### 按智能体的沙箱配置（多智能体）

如果使用多智能体路由，每个智能体可以覆盖沙箱和工具设置：`agents.list[].sandbox` 和 `agents.list[].tools`（以及 `agents.list[].tools.sandbox.tools`）。这允许你在一个 Gateway网关中运行混合访问级别：

- 完全访问（个人智能体）
- 只读工具 + 只读工作区（家庭/工作智能体）
- 无文件系统/shell 工具（公共智能体）

示例、优先级和故障排除详见 [多智能体沙箱与工具](/multi-agent-sandbox-tools)。

### 默认行为

- 镜像：`openclaw-sandbox:bookworm-slim`
- 每个智能体一个容器
- 智能体工作区访问：`workspaceAccess: "none"`（默认）使用 `~/.openclaw/sandboxes`
  - `"ro"` 将沙箱工作区保留在 `/workspace`，并将智能体工作区以只读方式挂载到 `/agent`（禁用 `write`/`edit`/`apply_patch`）
  - `"rw"` 将智能体工作区以读写方式挂载到 `/workspace`
- 自动清理：空闲超过 24 小时或创建超过 7 天
- 网络：默认为 `none`（需要出站访问时请显式启用）
- 默认允许：`exec`、`process`、`read`、`write`、`edit`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- 默认拒绝：`browser`、`canvas`、`nodes`、`cron`、`discord`、`gateway`

### 启用沙箱

如果你计划在 `setupCommand` 中安装软件包，请注意：

- 默认 `docker.network` 为 `"none"`（无出站访问）。
- `readOnlyRoot: true` 会阻止软件包安装。
- `user` 必须是 root 才能运行 `apt-get`（省略 `user` 或设置 `user: "0:0"`）。
  当 `setupCommand`（或 docker 配置）发生变更时，OpenClaw 会自动重建容器，除非容器**最近被使用过**（约 5 分钟内）。活跃容器会记录一条警告，包含确切的 `openclaw sandbox recreate ...` 命令。

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
          maxAgeDays: 7, // 0 禁用最大时限清理
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

加固选项位于 `agents.defaults.sandbox.docker` 下：
`network`、`user`、`pidsLimit`、`memory`、`memorySwap`、`cpus`、`ulimits`、
`seccompProfile`、`apparmorProfile`、`dns`、`extraHosts`。

多智能体：通过 `agents.list[].sandbox.{docker,browser,prune}.*` 按智能体覆盖 `agents.defaults.sandbox.{docker,browser,prune}.*`
（当 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 为 `"shared"` 时忽略）。

### 构建默认沙箱镜像

```bash
scripts/sandbox-setup.sh
```

这会使用 `Dockerfile.sandbox` 构建 `openclaw-sandbox:bookworm-slim`。

### 沙箱通用镜像（可选）

如果你需要包含常用构建工具（Node、Go、Rust 等）的沙箱镜像，请构建通用镜像：

```bash
scripts/sandbox-common-setup.sh
```

这会构建 `openclaw-sandbox-common:bookworm-slim`。使用方法：

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

要在沙箱内运行浏览器工具，请构建浏览器镜像：

```bash
scripts/sandbox-browser-setup.sh
```

这会使用 `Dockerfile.sandbox-browser` 构建 `openclaw-sandbox-browser:bookworm-slim`。容器运行启用了 CDP 的 Chromium，并提供可选的 noVNC 观察器（通过 Xvfb 实现有头模式）。

注意事项：

- 有头模式（Xvfb）比无头模式更能减少机器人检测。
- 仍可通过设置 `agents.defaults.sandbox.browser.headless=true` 使用无头模式。
- 不需要完整的桌面环境（GNOME）；Xvfb 提供显示。

配置用法：

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

启用后，智能体会收到：

- 沙箱浏览器控制 URL（用于 `browser` 工具）
- noVNC URL（如果已启用且 headless=false）

注意：如果你使用了工具允许列表，请添加 `browser`（并从拒绝列表中移除），否则该工具仍会被阻止。
清理规则（`agents.defaults.sandbox.prune`）也适用于浏览器容器。

### 自定义沙箱镜像

构建你自己的镜像并在配置中指向它：

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
- 如果 `allow` 为空：所有工具（除拒绝的）均可用。
- 如果 `allow` 不为空：仅 `allow` 中的工具可用（减去拒绝的）。

### 清理策略

两个配置项：

- `prune.idleHours`：移除超过 X 小时未使用的容器（0 = 禁用）
- `prune.maxAgeDays`：移除超过 X 天的容器（0 = 禁用）

示例：

- 保留活跃会话但限制生命周期：
  `idleHours: 24`，`maxAgeDays: 7`
- 从不清理：
  `idleHours: 0`，`maxAgeDays: 0`

### 安全说明

- 硬隔离仅适用于**工具**（exec/read/write/edit/apply_patch）。
- 仅限主机的工具（如 browser/camera/canvas）默认被阻止。
- 在沙箱中允许 `browser` 会**破坏隔离**（浏览器运行在主机上）。

## 故障排除

- 镜像缺失：使用 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 构建或设置 `agents.defaults.sandbox.docker.image`。
- 容器未运行：它会按需在每个会话中自动创建。
- 沙箱中的权限错误：将 `docker.user` 设置为与挂载工作区所有权匹配的 UID:GID（或对工作区文件夹执行 chown）。
- 找不到自定义工具：OpenClaw 使用 `sh -lc`（登录 shell）运行命令，这会加载 `/etc/profile` 并可能重置 PATH。请设置 `docker.env.PATH` 以前置你的自定义工具路径（例如 `/custom/bin:/usr/local/share/npm-global/bin`），或在 Dockerfile 中的 `/etc/profile.d/` 下添加脚本。
