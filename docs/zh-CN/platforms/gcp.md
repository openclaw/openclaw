---
read_when:
  - 你希望在 GCP 上全天候运行 OpenClaw
  - 你希望在自己的虚拟机上运行生产级、始终在线的 Gateway网关
  - 你希望完全掌控持久化、二进制文件和重启行为
summary: 在 GCP Compute Engine 虚拟机上全天候运行 OpenClaw Gateway网关（Docker），并实现持久化状态存储
title: GCP
x-i18n:
  generated_at: "2026-02-01T21:33:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: abb236dd421505d307bb3869340c9a0c940de095b93af9ad1f130cc08a9deadb
  source_path: platforms/gcp.md
  workflow: 15
---

# 在 GCP Compute Engine 上运行 OpenClaw（Docker，生产环境 VPS 指南）

## 目标

使用 Docker 在 GCP Compute Engine 虚拟机上运行持久化的 OpenClaw Gateway网关，实现持久状态存储、内置二进制文件和安全的重启行为。

如果你想"以每月约 $5-12 的成本全天候运行 OpenClaw"，这是在 Google Cloud 上的可靠方案。
价格因机器类型和区域而异；选择适合你工作负载的最小虚拟机，如果遇到 OOM 再进行扩容。

## 我们要做什么（简单说明）？

- 创建 GCP 项目并启用计费
- 创建 Compute Engine 虚拟机
- 安装 Docker（隔离的应用运行时）
- 在 Docker 中启动 OpenClaw Gateway网关
- 将 `~/.openclaw` + `~/.openclaw/workspace` 持久化到宿主机（重启/重建后数据不丢失）
- 通过 SSH 隧道从笔记本电脑访问控制界面

Gateway网关可通过以下方式访问：

- 从笔记本电脑进行 SSH 端口转发
- 如果你自行管理防火墙和令牌，可直接暴露端口

本指南使用 GCP Compute Engine 上的 Debian。
Ubuntu 同样适用；请相应地映射软件包。
有关通用 Docker 流程，请参阅 [Docker](/install/docker)。

---

## 快速路径（有经验的运维人员）

1. 创建 GCP 项目 + 启用 Compute Engine API
2. 创建 Compute Engine 虚拟机（e2-small，Debian 12，20GB）
3. SSH 连接到虚拟机
4. 安装 Docker
5. 克隆 OpenClaw 仓库
6. 创建持久化宿主机目录
7. 配置 `.env` 和 `docker-compose.yml`
8. 内置所需二进制文件，构建并启动

---

## 前提条件

- GCP 账户（e2-micro 可享受免费层级）
- 已安装 gcloud CLI（或使用 Cloud Console）
- 笔记本电脑可进行 SSH 访问
- 基本的 SSH 操作和复制/粘贴能力
- 约 20-30 分钟
- Docker 和 Docker Compose
- 模型认证凭据
- 可选的提供商凭据
  - WhatsApp 二维码
  - Telegram 机器人令牌
  - Gmail OAuth

---

## 1）安装 gcloud CLI（或使用 Console）

**选项 A：gcloud CLI**（推荐用于自动化）

从 https://cloud.google.com/sdk/docs/install 安装

初始化并认证：

```bash
gcloud init
gcloud auth login
```

**选项 B：Cloud Console**

所有步骤均可通过 https://console.cloud.google.com 的 Web 界面完成

---

## 2）创建 GCP 项目

**CLI：**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway网关"
gcloud config set project my-openclaw-project
```

在 https://console.cloud.google.com/billing 启用计费（Compute Engine 必需）。

启用 Compute Engine API：

```bash
gcloud services enable compute.googleapis.com
```

**Console：**

1. 前往 IAM & Admin > Create Project
2. 命名并创建
3. 为项目启用计费
4. 导航至 APIs & Services > Enable APIs > 搜索 "Compute Engine API" > 启用

---

## 3）创建虚拟机

**机器类型：**

| 类型     | 规格                     | 费用           | 备注             |
| -------- | ------------------------ | -------------- | ---------------- |
| e2-small | 2 vCPU，2GB 内存         | 约 $12/月      | 推荐             |
| e2-micro | 2 vCPU（共享），1GB 内存 | 可享受免费层级 | 高负载下可能 OOM |

**CLI：**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console：**

1. 前往 Compute Engine > VM instances > Create instance
2. 名称：`openclaw-gateway`
3. 区域：`us-central1`，可用区：`us-central1-a`
4. 机器类型：`e2-small`
5. 启动磁盘：Debian 12，20GB
6. 创建

---

## 4）SSH 连接到虚拟机

**CLI：**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console：**

在 Compute Engine 控制面板中点击虚拟机旁边的 "SSH" 按钮。

注意：虚拟机创建后，SSH 密钥传播可能需要 1-2 分钟。如果连接被拒绝，请等待后重试。

---

## 5）安装 Docker（在虚拟机上）

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

注销并重新登录以使用户组变更生效：

```bash
exit
```

然后重新 SSH 连接：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

验证：

```bash
docker --version
docker compose version
```

---

## 6）克隆 OpenClaw 仓库

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

本指南假设你将构建自定义镜像以确保二进制文件的持久化。

---

## 7）创建持久化宿主机目录

Docker 容器是临时性的。
所有长期状态必须存储在宿主机上。

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8）配置环境变量

在仓库根目录创建 `.env`。

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

生成强密钥：

```bash
openssl rand -hex 32
```

**请勿提交此文件。**

---

## 9）Docker Compose 配置

创建或更新 `docker-compose.yml`。

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
      # 推荐：在虚拟机上保持 Gateway网关仅监听 local loopback；通过 SSH 隧道访问。
      # 如需公开暴露，移除 `127.0.0.1:` 前缀并相应配置防火墙。
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # 可选：仅当你对此虚拟机运行 iOS/Android 节点并需要 Canvas 主机时使用。
      # 如果公开暴露此端口，请阅读 /gateway/security 并相应配置防火墙。
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

## 10）将所需二进制文件内置到镜像中（关键步骤）

在运行中的容器内安装二进制文件是一个陷阱。
运行时安装的任何内容在重启后都会丢失。

所有 Skills 所需的外部二进制文件必须在镜像构建时安装。

以下示例仅展示三个常见的二进制文件：

- `gog` 用于 Gmail 访问
- `goplaces` 用于 Google Places
- `wacli` 用于 WhatsApp

这些只是示例，并非完整列表。
你可以使用相同的模式安装所需的任意数量的二进制文件。

如果之后添加了依赖其他二进制文件的新 Skills，你必须：

1. 更新 Dockerfile
2. 重新构建镜像
3. 重启容器

**示例 Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# 示例二进制文件 1：Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 示例二进制文件 2：Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 示例二进制文件 3：WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 使用相同模式在下方添加更多二进制文件

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

## 11）构建并启动

```bash
docker compose build
docker compose up -d openclaw-gateway
```

验证二进制文件：

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

预期输出：

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12）验证 Gateway网关

```bash
docker compose logs -f openclaw-gateway
```

成功标志：

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13）从笔记本电脑访问

创建 SSH 隧道以转发 Gateway网关端口：

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

在浏览器中打开：

`http://127.0.0.1:18789/`

粘贴你的 Gateway网关令牌。

---

## 持久化存储位置（数据来源）

OpenClaw 在 Docker 中运行，但 Docker 并非数据来源。
所有长期状态必须在重启、重建和重启动后仍然存在。

| 组件            | 位置                              | 持久化机制      | 备注                        |
| --------------- | --------------------------------- | --------------- | --------------------------- |
| Gateway网关配置 | `/home/node/.openclaw/`           | 宿主机卷挂载    | 包含 `openclaw.json`、令牌  |
| 模型认证配置    | `/home/node/.openclaw/`           | 宿主机卷挂载    | OAuth 令牌、API 密钥        |
| Skills配置      | `/home/node/.openclaw/skills/`    | 宿主机卷挂载    | Skills 级别状态             |
| 智能体工作区    | `/home/node/.openclaw/workspace/` | 宿主机卷挂载    | 代码和智能体产物            |
| WhatsApp 会话   | `/home/node/.openclaw/`           | 宿主机卷挂载    | 保留二维码登录              |
| Gmail 密钥环    | `/home/node/.openclaw/`           | 宿主机卷 + 密码 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二进制文件  | `/usr/local/bin/`                 | Docker 镜像     | 必须在构建时内置            |
| Node 运行时     | 容器文件系统                      | Docker 镜像     | 每次镜像构建时重建          |
| 操作系统软件包  | 容器文件系统                      | Docker 镜像     | 请勿在运行时安装            |
| Docker 容器     | 临时性                            | 可重启          | 可安全销毁                  |

---

## 更新

在虚拟机上更新 OpenClaw：

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## 故障排除

**SSH 连接被拒绝**

虚拟机创建后，SSH 密钥传播可能需要 1-2 分钟。请等待后重试。

**OS Login 问题**

检查你的 OS Login 配置：

```bash
gcloud compute os-login describe-profile
```

确保你的账户具有所需的 IAM 权限（Compute OS Login 或 Compute OS Admin Login）。

**内存不足 (OOM)**

如果使用 e2-micro 并遇到 OOM，请升级到 e2-small 或 e2-medium：

```bash
# 先停止虚拟机
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# 更改机器类型
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# 启动虚拟机
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## 服务账户（安全最佳实践）

个人使用时，默认用户账户即可。

对于自动化或 CI/CD 流水线，请创建具有最小权限的专用服务账户：

1. 创建服务账户：

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. 授予 Compute Instance Admin 角色（或更精细的自定义角色）：
   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

避免在自动化中使用 Owner 角色。请遵循最小权限原则。

有关 IAM 角色详情，请参阅 https://cloud.google.com/iam/docs/understanding-roles。

---

## 后续步骤

- 设置消息渠道：[渠道](/channels)
- 将本地设备配对为节点：[节点](/nodes)
- 配置 Gateway网关：[Gateway网关配置](/gateway/configuration)
