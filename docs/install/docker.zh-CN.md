---
summary: "OpenClaw 的可选基于 Docker 的设置和引导流程"
read_when:
  - 您想要容器化网关而不是本地安装
  - 您正在验证 Docker 流程
title: "Docker"
---

# Docker（可选）

Docker 是 **可选** 的。仅在您想要容器化网关或验证 Docker 流程时使用。

## Docker 适合我吗？

- **是**：您想要一个隔离的、一次性的网关环境，或在没有本地安装的主机上运行 OpenClaw。
- **否**：您在自己的机器上运行，只想要最快的开发循环。请改用正常的安装流程。
- **沙箱说明**：代理沙箱也使用 Docker，但它 **不需要** 整个网关在 Docker 中运行。请参阅 [沙箱](/gateway/sandboxing)。

## 先决条件

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 至少 2 GB RAM 用于镜像构建（`pnpm install` 在 1 GB 主机上可能因 OOM 被杀死，退出代码 137）
- 足够的磁盘空间用于镜像和日志
- 如果在 VPS/公共主机上运行，请查看
  [网络暴露的安全加固](/gateway/security)，
  特别是 Docker `DOCKER-USER` 防火墙策略。

## 容器化网关

<Steps>
  <Step title="构建镜像">
    从仓库根目录运行设置脚本：

    ```bash
    ./scripts/docker/setup.sh
    ```

    这会在本地构建网关镜像。要使用预构建的镜像：

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    预构建镜像发布在
    [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw)。
    常见标签：`main`、`latest`、`<version>`（例如 `2026.2.26`）。

  </Step>

  <Step title="完成引导流程">
    设置脚本会自动运行引导流程。它将：

    - 提示输入提供商 API 密钥
    - 生成网关令牌并将其写入 `.env`
    - 通过 Docker Compose 启动网关

    在设置期间，启动前的引导和配置写入通过
    `openclaw-gateway` 直接运行。`openclaw-cli` 用于网关容器已经存在后运行的命令。

  </Step>

  <Step title="打开控制 UI">
    在浏览器中打开 `http://127.0.0.1:18789/` 并将配置的共享密钥粘贴到设置中。设置脚本默认将令牌写入 `.env`；如果您将容器配置切换为密码认证，请改用该密码。

    需要再次获取 URL？

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

  </Step>

  <Step title="配置频道（可选）">
    使用 CLI 容器添加消息频道：

    ```bash
    # WhatsApp（QR 码）
    docker compose run --rm openclaw-cli channels login

    # Telegram
    docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"

    # Discord
    docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
    ```

    文档：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)

  </Step>
</Steps>

### 手动流程

如果您更喜欢自己运行每个步骤而不是使用设置脚本：

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm --no-deps --entrypoint node openclaw-gateway 
  dist/index.js onboard --mode local --no-install-daemon
docker compose run --rm --no-deps --entrypoint node openclaw-gateway 
  dist/index.js config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]'
docker compose up -d openclaw-gateway
```

<Note>
从仓库根目录运行 `docker compose`。如果您启用了 `OPENCLAW_EXTRA_MOUNTS`
或 `OPENCLAW_HOME_VOLUME`，设置脚本会写入 `docker-compose.extra.yml`；
使用 `-f docker-compose.yml -f docker-compose.extra.yml` 包含它。
</Note>

<Note>
因为 `openclaw-cli` 共享 `openclaw-gateway` 的网络命名空间，它是一个
启动后工具。在 `docker compose up -d openclaw-gateway` 之前，通过 `openclaw-gateway` 运行引导和设置时的配置写入，使用
`--no-deps --entrypoint node`。
</Note>

### 环境变量

设置脚本接受这些可选的环境变量：

| 变量                       | 用途                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `OPENCLAW_IMAGE`               | 使用远程镜像而不是在本地构建                   |
| `OPENCLAW_DOCKER_APT_PACKAGES` | 在构建期间安装额外的 apt 包（空格分隔）        |
| `OPENCLAW_EXTENSIONS`          | 在构建时预安装扩展依赖（空格分隔的名称） |
| `OPENCLAW_EXTRA_MOUNTS`        | 额外的主机绑定挂载（逗号分隔的 `source:target[:opts]`）  |
| `OPENCLAW_HOME_VOLUME`         | 在命名 Docker 卷中持久化 `/home/node`                    |
| `OPENCLAW_SANDBOX`             | 选择加入沙箱引导（`1`、`true`、`yes`、`on`）           |
| `OPENCLAW_DOCKER_SOCKET`       | 覆盖 Docker 套接字路径                                      |

### 健康检查

容器探针端点（不需要认证）：

```bash
curl -fsS http://127.0.0.1:18789/healthz   # 存活
curl -fsS http://127.0.0.1:18789/readyz     # 就绪
```

Docker 镜像包含内置的 `HEALTHCHECK`，它会 ping `/healthz`。
如果检查持续失败，Docker 会将容器标记为 `unhealthy`，编排系统可以重启或替换它。

需要认证的深度健康快照：

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### LAN vs 回环

`scripts/docker/setup.sh` 默认设置 `OPENCLAW_GATEWAY_BIND=lan`，因此主机访问
`http://127.0.0.1:18789` 通过 Docker 端口发布工作。

- `lan`（默认）：主机浏览器和主机 CLI 可以访问发布的网关端口。
- `loopback`：只有容器网络命名空间内的进程可以直接访问
  网关。

<Note>
在 `gateway.bind` 中使用绑定模式值（`lan` / `loopback` / `custom` /
`tailnet` / `auto`），而不是主机别名如 `0.0.0.0` 或 `127.0.0.1`。
</Note>

### 存储和持久性

Docker Compose 将 `OPENCLAW_CONFIG_DIR` 绑定挂载到 `/home/node/.openclaw`，将
`OPENCLAW_WORKSPACE_DIR` 绑定挂载到 `/home/node/.openclaw/workspace`，因此这些路径
在容器替换后仍然存在。

那个挂载的配置目录是 OpenClaw 保存以下内容的地方：

- `openclaw.json` 用于行为配置
- `agents/<agentId>/agent/auth-profiles.json` 用于存储的提供商 OAuth/API 密钥认证
- `.env` 用于基于环境的运行时密钥，如 `OPENCLAW_GATEWAY_TOKEN`

有关 VM 部署的完整持久性详细信息，请参阅
[Docker VM Runtime - What persists where](/install/docker-vm-runtime#what-persists-where)。

**磁盘增长热点**：注意 `media/`、会话 JSONL 文件、`cron/runs/*.jsonl`，
以及 `/tmp/openclaw/` 下的滚动文件日志。

### Shell 助手（可选）

为了更轻松地进行日常 Docker 管理，安装 `ClawDock`：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

如果您从旧的 `scripts/shell-helpers/clawdock-helpers.sh` 原始路径安装了 ClawDock，请重新运行上面的安装命令，以便您的本地助手文件跟踪新位置。

然后使用 `clawdock-start`、`clawdock-stop`、`clawdock-dashboard` 等。运行
`clawdock-help` 查看所有命令。
有关完整的助手指南，请参阅 [ClawDock](/install/clawdock)。

<AccordionGroup>
  <Accordion title="为 Docker 网关启用代理沙箱">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    自定义套接字路径（例如无根 Docker）：

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    脚本仅在沙箱先决条件通过后才挂载 `docker.sock`。如果
    沙箱设置无法完成，脚本会将 `agents.defaults.sandbox.mode` 重置
    为 `off`。

  </Accordion>

  <Accordion title="自动化 / CI（非交互式）">
    使用 `-T` 禁用 Compose 伪 TTY 分配：

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="共享网络安全说明">
    `openclaw-cli` 使用 `network_mode: "service:openclaw-gateway"`，因此 CLI
    命令可以通过 `127.0.0.1` 访问网关。将此视为共享
    信任边界。compose 配置在 `openclaw-cli` 上删除 `NET_RAW`/`NET_ADMIN` 并启用
    `no-new-privileges`。
  </Accordion>

  <Accordion title="权限和 EACCES">
    镜像以 `node`（uid 1000）运行。如果您在
    `/home/node/.openclaw` 上看到权限错误，请确保您的主机绑定挂载由 uid 1000 拥有：

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

  </Accordion>

  <Accordion title="更快的重建">
    排序您的 Dockerfile，使依赖层被缓存。这避免在锁文件更改时重新运行
    `pnpm install`：

    ```dockerfile
    FROM node:24-bookworm
    RUN curl -fsSL https://bun.sh/install | bash
    ENV PATH="/root/.bun/bin:${PATH}"
    RUN corepack enable
    WORKDIR /app
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

  </Accordion>

  <Accordion title="高级用户容器选项">
    默认镜像是安全优先的，以非根 `node` 运行。对于功能更全面的容器：

    1. **持久化 `/home/node`**：`export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **烘焙系统依赖**：`export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"`
    3. **安装 Playwright 浏览器**：
       ```bash
       docker compose run --rm openclaw-cli 
         node /app/node_modules/playwright-core/cli.js install chromium
       ```
    4. **持久化浏览器下载**：设置
       `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` 并使用
       `OPENCLAW_HOME_VOLUME` 或 `OPENCLAW_EXTRA_MOUNTS`。

  </Accordion>

  <Accordion title="OpenAI Codex OAuth（无头 Docker）">
    如果您在向导中选择 OpenAI Codex OAuth，它会打开一个浏览器 URL。在
    Docker 或无头设置中，复制您到达的完整重定向 URL 并将其粘贴
    回向导以完成认证。
  </Accordion>

  <Accordion title="基础镜像元数据">
    主 Docker 镜像使用 `node:24-bookworm` 并发布 OCI 基础镜像
    注释，包括 `org.opencontainers.image.base.name`、
    `org.opencontainers.image.source` 等。请参阅
    [OCI 镜像注释](https://github.com/opencontainers/image-spec/blob/main/annotations.md)。
  </Accordion>
</AccordionGroup>

### 在 VPS 上运行？

请参阅 [Hetzner (Docker VPS)](/install/hetzner) 和
[Docker VM Runtime](/install/docker-vm-runtime) 了解共享 VM 部署步骤，
包括二进制烘焙、持久性和更新。

## 代理沙箱

当 `agents.defaults.sandbox` 启用时，网关在隔离的 Docker 容器中运行代理工具执行
（shell、文件读写等），而网关本身留在主机上。这在不受信任或
多租户代理会话周围给您一个硬墙，而无需容器化整个网关。

沙箱范围可以是每个代理（默认）、每个会话或共享。每个范围
都有自己的工作区，挂载在 `/workspace`。您还可以配置
允许/拒绝工具策略、网络隔离、资源限制和浏览器
容器。

有关完整配置、镜像、安全说明和多代理配置文件，请参阅：

- [沙箱](/gateway/sandboxing) -- 完整的沙箱参考
- [OpenShell](/gateway/openshell) -- 沙箱容器的交互式 shell 访问
- [多代理沙箱和工具](/tools/multi-agent-sandbox-tools) -- 每个代理的覆盖

### 快速启用

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
      },
    },
  },
}
```

构建默认沙箱镜像：

```bash
scripts/sandbox-setup.sh
```

## 故障排除

<AccordionGroup>
  <Accordion title="镜像缺失或沙箱容器未启动">
    使用
    [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)
    构建沙箱镜像，或设置 `agents.defaults.sandbox.docker.image` 为您的自定义镜像。
    容器按需为每个会话自动创建。
  </Accordion>

  <Accordion title="沙箱中的权限错误">
    将 `docker.user` 设置为与您挂载的工作区所有权匹配的 UID:GID，
    或 chown 工作区文件夹。
  </Accordion>

  <Accordion title="沙箱中未找到自定义工具">
    OpenClaw 使用 `sh -lc`（登录 shell）运行命令，它会源
    `/etc/profile` 并可能重置 PATH。设置 `docker.env.PATH` 以添加您的
    自定义工具路径，或在您的 Dockerfile 中的 `/etc/profile.d/` 下添加脚本。
  </Accordion>

  <Accordion title="镜像构建期间 OOM 被杀死（退出 137）">
    VM 需要至少 2 GB RAM。使用更大的机器类别并重试。
  </Accordion>

  <Accordion title="控制 UI 中显示未授权或需要配对">
    获取新的仪表板链接并批准浏览器设备：

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    更多详细信息：[仪表板](/web/dashboard)、[设备](/cli/devices)。

  </Accordion>

  <Accordion title="网关目标显示 ws://172.x.x.x 或来自 Docker CLI 的配对错误">
    重置网关模式和绑定：

    ```bash
    docker compose run --rm openclaw-cli config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"}]'
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>

## 相关

- [安装概览](/install) — 所有安装方法
- [Podman](/install/podman) — Docker 的 Podman 替代品
- [ClawDock](/install/clawdock) — Docker Compose 社区设置
- [更新](/install/updating) — 保持 OpenClaw 最新
- [配置](/gateway/configuration) — 安装后的网关配置