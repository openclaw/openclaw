---
summary: "OpenClaw 的可选 Docker 安装和 onboarding"
read_when:
  - 您想要容器化的 gateway 而不是本地安装
  - 您正在验证 Docker 流程
title: "Docker"
---

Docker 是**可选的**。仅在您想要容器化 gateway 或验证 Docker 流程时使用。

## Docker 适合我吗？

- **是**：您想要一个隔离的、可丢弃的 gateway 环境，或在没有本地安装的主机上运行 OpenClaw。
- **否**：您在自己的机器上运行，只想要最快的开发循环。请改用正常的安装流程。
- **沙箱说明**：默认沙箱后端在启用沙箱时使用 Docker，但沙箱默认关闭，**不需要**整个 gateway 在 Docker 中运行。SSH 和 OpenShell 沙箱后端也可用。参见 [Sandboxing](/gateway/sandboxing)。

## 前置条件

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 至少 2 GB RAM 用于镜像构建（`pnpm install` 在 1 GB 主机上可能会 OOM 被杀，退出码 137）
- 足够的磁盘空间用于镜像和日志
- 如果在 VPS/公共主机上运行，请查看
  [网络暴露的安全加固](/gateway/security)，
  特别是 Docker `DOCKER-USER` 防火墙策略。

## 容器化 gateway

<Steps>
  <Step title="构建镜像">
    从仓库根目录运行设置脚本：

    ```bash
    ./scripts/docker/setup.sh
    ```

    这会在本地构建 gateway 镜像。要使用预构建镜像：

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    预构建镜像发布在
    [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw)。
    常用标签：`main`、`latest`、`<version>`（例如 `2026.2.26`）。

  </Step>

  <Step title="完成 onboarding">
    设置脚本自动运行 onboarding。它会：

    - 提示输入 provider API keys
    - 生成 gateway token 并写入 `.env`
    - 通过 Docker Compose 启动 gateway

    在设置期间，pre-start onboarding 和配置写入通过
    `openclaw-gateway` 直接运行。`openclaw-cli` 用于在
    gateway 容器已存在后运行的命令。

  </Step>

  <Step title="打开 Control UI">
    在浏览器中打开 `http://127.0.0.1:18789/` 并将配置的共享密钥粘贴到设置中。设置脚本默认将 token 写入 `.env`；如果您切换到密码 auth，请使用该密码。

    再次需要 URL？

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

  </Step>

  <Step title="配置渠道（可选）">
    使用 CLI 容器添加消息渠道：

    ```bash
    # WhatsApp (QR)
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
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --mode local --no-install-daemon
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]'
docker compose up -d openclaw-gateway
```

<Note>
从仓库根目录运行 `docker compose`。如果启用了 `OPENCLAW_EXTRA_MOUNTS`
或 `OPENCLAW_HOME_VOLUME`，设置脚本会写入 `docker-compose.extra.yml`；
使用 `-f docker-compose.yml -f docker-compose.extra.yml` 包含它。
</Note>

<Note>
因为 `openclaw-cli` 共享 `openclaw-gateway` 的网络命名空间，它是一个
启动后工具。在 `docker compose up -d openclaw-gateway` 之前，通过
`--no-deps --entrypoint node` 对 `openclaw-gateway` 运行 onboarding
和设置时配置写入。
</Note>

### 环境变量

设置脚本接受以下可选环境变量：

| 变量                                   | 用途                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| `OPENCLAW_IMAGE`                           | 使用远程镜像而不是本地构建                  |
| `OPENCLAW_DOCKER_APT_PACKAGES`             | 在构建期间安装额外的 apt 包（空格分隔）       |
| `OPENCLAW_EXTENSIONS`                      | 在构建时预安装插件依赖（空格分隔的名称）   |
| `OPENCLAW_EXTRA_MOUNTS`                    | 额外主机绑定挂载（逗号分隔的 `source:target[:opts]`） |
| `OPENCLAW_HOME_VOLUME`                     | 在命名 Docker 卷中持久化 `/home/node`                   |
| `OPENCLAW_PLUGIN_STAGE_DIR`                | 生成的捆绑插件依赖和镜像的容器路径          |
| `OPENCLAW_SANDBOX`                         | 选择加入沙箱引导（`1`、`true`、`yes`、`on`）          |
| `OPENCLAW_DOCKER_SOCKET`                   | 覆盖 Docker socket 路径                                     |
| `OPENCLAW_DISABLE_BONJOUR`                 | 禁用 Bonjour/mDNS 广告（Docker 默认为 `1`）       |
| `OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS` | 禁用捆绑插件源绑定挂载覆盖                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`              | OpenTelemetry 导出的共享 OTLP/HTTP 收集器端点    |
| `OTEL_EXPORTER_OTLP_*_ENDPOINT`            | 追踪、指标或日志的信号特定 OTLP 端点      |
| `OTEL_EXPORTER_OTLP_PROTOCOL`              | OTLP 协议覆盖。今天仅支持 `http/protobuf`    |
| `OTEL_SERVICE_NAME`                        | 用于 OpenTelemetry 资源的服务名称                       |
| `OTEL_SEMCONV_STABILITY_OPT_IN`            | 选择加入最新的实验性 GenAI 语义属性           |
| `OPENCLAW_OTEL_PRELOADED`                  | 当已预加载一个 OpenTelemetry SDK 时跳过启动第二个   |

维护人员可以通过将一个插件源目录挂载到其打包源路径上来测试打包镜像中的捆绑插件源，例如
`OPENCLAW_EXTRA_MOUNTS=/path/to/fork/extensions/synology-chat:/app/extensions/synology-chat:ro`。
该挂载的源目录覆盖同名插件的已编译 `/app/dist/extensions/synology-chat` 捆绑包。

### 可观测性

OpenTelemetry 导出是从 Gateway 容器到您的 OTLP
收集器的出站流量。它不需要发布的 Docker 端口。如果您在本地构建镜像
并希望镜像内提供捆绑的 OpenTelemetry 导出器，
请包含其运行时依赖：

```bash
export OPENCLAW_EXTENSIONS="diagnostics-otel"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"
export OTEL_SERVICE_NAME="openclaw-gateway"
./scripts/docker/setup.sh
```

官方 OpenClaw Docker 发布镜像包含捆绑的
`diagnostics-otel` 插件源。根据镜像和缓存状态，
Gateway 可能在插件首次启用时仍然暂存插件本地 OpenTelemetry 运行时依赖，
因此允许该首次启动到达包注册表或在您的发布流水线中预热镜像。
要启用导出，请在配置中允许并启用 `diagnostics-otel` 插件，
然后设置 `diagnostics.otel.enabled=true` 或使用
[OpenTelemetry 导出](/gateway/opentelemetry) 中的配置示例。
收集器 auth 头通过 `diagnostics.otel.headers` 配置，
而不是通过 Docker 环境变量。

Prometheus 指标使用已发布的 Gateway 端口。启用
`diagnostics-prometheus` 插件，然后抓取：

```text
http://<gateway-host>:18789/api/diagnostics/prometheus
```

该路由受 Gateway 认证保护。不要公开单独的公共 `/metrics` 端口
或无认证的反向代理路径。参见
[Prometheus 指标](/gateway/prometheus)。

### 健康检查

容器探针端点（无需认证）：

```bash
curl -fsS http://127.0.0.1:18789/healthz   # 存活探针
curl -fsS http://127.0.0.1:18789/readyz     # 就绪探针
```

Docker 镜像包含内置的 `HEALTHCHECK`，它 ping `/healthz`。
如果检查持续失败，Docker 会将容器标记为 `unhealthy`，
编排系统可以重启或替换它。

认证的深度健康快照：

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### LAN vs loopback

`scripts/docker/setup.sh` 默认设置 `OPENCLAW_GATEWAY_BIND=lan`，
以便主机访问 `http://127.0.0.1:18789` 与 Docker 端口发布配合工作。

- `lan`（默认）：主机浏览器和主机 CLI 可以访问已发布的 gateway 端口。
- `loopback`：只有容器网络命名空间内的进程可以直接访问 gateway。

<Note>
在 `gateway.bind`（`lan` / `loopback` / `custom` /
`tailnet` / `auto`）中使用绑定模式值，而不是主机别名如 `0.0.0.0` 或 `127.0.0.1`。
</Note>

### 主机本地 Providers

当 OpenClaw 在 Docker 中运行时，容器内的 `127.0.0.1` 是容器本身，
而不是您的宿主机。对于在主机上运行的 AI providers，
使用 `host.docker.internal`：

| Provider  | 主机默认 URL         | Docker 设置 URL                    |
| --------- | ------------------------ | ----------------------------------- |
| LM Studio | `http://127.0.0.1:1234`  | `http://host.docker.internal:1234`  |
| Ollama    | `http://127.0.0.1:11434` | `http://host.docker.internal:11434` |

捆绑的 Docker 设置使用这些主机 URL 作为 LM Studio 和 Ollama
onboarding 默认值，`docker-compose.yml` 将 `host.docker.internal`
映射到 Linux Docker Engine 的 Docker 主机网关。Docker Desktop
在 macOS 和 Windows 上已经提供相同的主机名。

主机服务还必须监听可从 Docker 到达的地址：

```bash
lms server start --port 1234 --bind 0.0.0.0
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

如果您使用自己的 Compose 文件或 `docker run` 命令，
请自己添加相同的主机映射，例如
`--add-host=host.docker.internal:host-gateway`。

### Bonjour / mDNS

Docker 桥接网络通常不能可靠地转发 Bonjour/mDNS 多播
（`224.0.0.251:5353`）。因此捆绑的 Compose 设置默认
`OPENCLAW_DISABLE_BONJOUR=1`，以便 Gateway 在桥接丢弃多播流量时
不会崩溃循环或反复重启广告。

对于 Docker 主机，使用已发布的 Gateway URL、Tailscale 或广域网 DNS-SD。
仅在运行 host networking、macvlan 或已知 mDNS 多播工作的其他网络时
设置 `OPENCLAW_DISABLE_BONJOUR=0`。

有关注意事项和故障排除，参见 [Bonjour discovery](/gateway/bonjour)。

### 存储和持久化

Docker Compose 绑定挂载 `OPENCLAW_CONFIG_DIR` 到 `/home/node/.openclaw` 和
`OPENCLAW_WORKSPACE_DIR` 到 `/home/node/.openclaw/workspace`，
因此这些路径在容器替换后保留。

该挂载的配置目录是 OpenClaw 保存以下内容的地方：

- `openclaw.json` 用于行为配置
- `agents/<agentId>/agent/auth-profiles.json` 用于存储的 provider OAuth/API-key auth
- `.env` 用于环境支持的运行时 secrets，如 `OPENCLAW_GATEWAY_TOKEN`

捆绑插件运行时依赖和镜像运行时文件是生成的 state，
不是用户配置。Compose 将它们存储在名为 Docker 卷
`openclaw-plugin-runtime-deps` 中，挂载在
`/var/lib/openclaw/plugin-runtime-deps`。将这个高变更树排除在
主机配置绑定挂载之外，可以避免 Docker Desktop/WSL 文件操作缓慢
和 Windows 在冷 Gateway 启动期间出现陈旧句柄。

默认 Compose 文件为 `openclaw-gateway` 和 `openclaw-cli` 设置
`OPENCLAW_PLUGIN_STAGE_DIR` 到该路径，因此 `openclaw doctor --fix`、
渠道登录/设置命令和 Gateway 启动都使用相同的生成运行时卷。

有关 VM 部署的完整持久化详情，参见
[Docker VM Runtime - 什么在哪里持久化](/install/docker-vm-runtime#what-persists-where)。

**磁盘增长热点：** 监视 `media/`、会话 JSONL 文件、`cron/runs/*.jsonl`、
`openclaw-plugin-runtime-deps` Docker 卷以及
`/tmp/openclaw/` 下的滚动文件日志。

### Shell 辅助工具（可选）

为了更方便的日常 Docker 管理，安装 `ClawDock`：

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawdock/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

如果您从旧的 `scripts/shell-helpers/clawdock-helpers.sh` 原始路径安装了 ClawDock，
请重新运行安装命令，以便您的本地辅助文件跟踪新位置。

然后使用 `clawdock-start`、`clawdock-stop`、`clawdock-dashboard` 等。
运行 `clawdock-help` 获取所有命令。
参见 [ClawDock](/install/clawdock) 获取完整的辅助指南。

<AccordionGroup>
  <Accordion title="为 Docker gateway 启用 agent 沙箱">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    自定义 socket 路径（例如 rootless Docker）：

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    脚本仅在沙箱先决条件通过后才挂载 `docker.sock`。如果
    沙箱设置无法完成，脚本会将 `agents.defaults.sandbox.mode`
    重置为 `off`。

  </Accordion>

  <Accordion title="自动化 / CI（非交互式）">
    使用 `-T` 禁用 Compose pseudo-TTY 分配：

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="共享网络安全说明">
    `openclaw-cli` 使用 `network_mode: "service:openclaw-gateway"`，以便 CLI
    命令可以通过 `127.0.0.1` 到达 gateway。将此视为共享
    信任边界。compose 配置在 `openclaw-cli` 上删除 `NET_RAW`/`NET_ADMIN`
    并启用 `no-new-privileges`。
  </Accordion>

  <Accordion title="权限和 EACCES">
    镜像以 `node`（uid 1000）身份运行。如果您在
    `/home/node/.openclaw` 上看到权限错误，请确保您的主机绑定挂载由 uid 1000 拥有：

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

  </Accordion>

  <Accordion title="更快重建">
    排序 Dockerfile 以便缓存依赖层。这可以避免重新运行
    `pnpm install`，除非 lockfiles 更改：

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
    默认镜像是安全优先的，以非 root `node` 运行。对于更完整的容器：

    1. **持久化 `/home/node`**：`export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **烘焙系统依赖**：`export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"`
    3. **安装 Playwright 浏览器**：
       ```bash
       docker compose run --rm openclaw-cli \
         node /app/node_modules/playwright-core/cli.js install chromium
       ```
    4. **持久化浏览器下载**：设置
       `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` 并使用
       `OPENCLAW_HOME_VOLUME` 或 `OPENCLAW_EXTRA_MOUNTS`。

  </Accordion>

  <Accordion title="OpenAI Codex OAuth（无头 Docker）">
    如果您在向导中选择了 OpenAI Codex OAuth，它会打开一个浏览器 URL。在
    Docker 或无头设置中，复制您到达的完整重定向 URL 并将其粘贴回
    向导以完成 auth。
  </Accordion>

  <Accordion title="基础镜像元数据">
    主 Docker 运行时镜像使用 `node:24-bookworm-slim` 并发布 OCI
    基础镜像注解，包括 `org.opencontainers.image.base.name`、
    `org.opencontainers.image.source` 等。Node 基础摘要通过
    Dependabot Docker 基础镜像 PR 刷新；发布构建不运行
    distro 升级层。参见
    [OCI 镜像注解](https://github.com/opencontainers/image-spec/blob/main/annotations.md)。
  </Accordion>
</AccordionGroup>

### 在 VPS 上运行？

参见 [Hetzner (Docker VPS)](/install/hetzner) 和
[Docker VM Runtime](/install/docker-vm-runtime) 了解共享 VM 部署步骤，
包括二进制 baking、持久化和更新。

## Agent 沙箱

当使用 Docker 后端启用 `agents.defaults.sandbox` 时，gateway
在隔离的 Docker 容器内运行 agent 工具执行（shell、文件读写等），
而 gateway 本身留在主机上。这为不受信任或多租户 agent 会话提供了
硬隔离，而无需将整个 gateway 容器化。

沙箱范围可以是按 agent（默认）、按会话或共享的。每个范围
获得自己的 workspace，挂载在 `/workspace`。您还可以配置
允许/拒绝工具策略、网络隔离、资源限制和浏览器容器。

有关完整配置、镜像、安全说明和多 agent 配置，参见：

- [Sandboxing](/gateway/sandboxing) — 完整的沙箱参考
- [OpenShell](/gateway/openshell) — 到沙箱容器的交互式 shell 访问
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) — 按 agent 覆盖

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
    构建沙箱镜像或将 `agents.defaults.sandbox.docker.image` 设置为您的自定义镜像。
    容器按需为每个会话自动创建。
  </Accordion>

  <Accordion title="沙箱中的权限错误">
    将 `docker.user` 设置为与您挂载的 workspace 所有权匹配的 UID:GID，
    或 chown workspace 文件夹。
  </Accordion>

  <Accordion title="沙箱中找不到自定义工具">
    OpenClaw 使用 `sh -lc`（登录 shell）运行命令，这会获取
    `/etc/profile` 并可能重置 PATH。将 `docker.env.PATH` 设置为
    预先添加您的自定义工具路径，或在 Dockerfile 中添加
    `/etc/profile.d/` 下的脚本。
  </Accordion>

  <Accordion title="镜像构建期间 OOM 被杀（退出码 137）">
    VM 需要至少 2 GB RAM。使用更大的机器类别并重试。
  </Accordion>

  <Accordion title="Control UI 中需要授权或配对">
    获取新的仪表板链接并批准浏览器设备：

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    更多详情：[Dashboard](/web/dashboard)、[Devices](/cli/devices)。

  </Accordion>

  <Accordion title="Gateway 目标显示 ws://172.x.x.x 或来自 Docker CLI 的配对错误">
    重置 gateway 模式和绑定：

    ```bash
    docker compose run --rm openclaw-cli config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"}]'
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>

## 相关

- [安装概述](/install) — 所有安装方式
- [Podman](/install/podman) — Docker 的 Podman 替代方案
- [ClawDock](/install/clawdock) — Docker Compose 社区设置
- [更新](/install/updating) — 保持 OpenClaw 最新
- [配置](/gateway/configuration) — 安装后的 gateway 配置
