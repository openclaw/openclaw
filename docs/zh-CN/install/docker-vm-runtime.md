---
summary: "在长时间运行的 OpenClaw Gateway 主机上共享 Docker VM 运行时步骤"
read_when:
  - 在云 VM 上部署 OpenClaw with Docker
  - 需要共享的二进制文件烘焙、持久化和更新流程
title: "Docker VM 运行时"
---

# Docker VM 运行时

适用于基于 VM 的 Docker 安装（如 GCP、Hetzner 和类似 VPS 提供商）的共享运行时步骤。

## 将所需二进制文件烘焙到镜像中

在运行中的容器内安装二进制文件是一个陷阱。
运行时安装的任何内容都将在重启时丢失。

技能所需的所有外部二进制文件必须在镜像构建时安装。

以下示例仅展示三个常用二进制文件：

- 用于 Gmail 访问的 `gog`
- 用于 Google Places 的 `goplaces`
- 用于 WhatsApp 的 `wacli`

这些是示例，不是完整列表。
您可以使用相同的模式安装任意数量的二进制文件。

如果稍后添加依赖其他二进制文件的新技能，您必须：

1. 更新 Dockerfile
2. 重建镜像
3. 重启容器

**示例 Dockerfile**

```dockerfile
FROM node:24-bookworm

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

<Note>
上述下载 URL 适用于 x86_64 (amd64)。对于基于 ARM 的 VM（例如 Hetzner ARM、GCP Tau T2A），请从每个工具的发布页面替换为相应的 ARM64 变体下载 URL。
</Note>

## 构建和启动

```bash
docker compose build
docker compose up -d openclaw-gateway
```

如果构建在 `pnpm install --frozen-lockfile` 期间因 `Killed` 或 `exit code 137` 失败，则 VM 内存不足。
重试前请使用更大的机器规格。

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

验证 Gateway：

```bash
docker compose logs -f openclaw-gateway
```

预期输出：

```
[gateway] listening on ws://0.0.0.0:18789
```

## 持久化位置

OpenClaw 在 Docker 中运行，但 Docker 不是数据源。
所有长期状态必须能够承受重启、重新构建和重启。

| 组件 | 位置 | 持久化机制 | 备注 |
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Gateway 配置 | `/home/node/.openclaw/` | 主机卷挂载 | 包括 `openclaw.json`、令牌 |
| 模型认证配置 | `/home/node/.openclaw/` | 主机卷挂载 | OAuth 令牌、API 密钥 |
| 技能配置 | `/home/node/.openclaw/skills/` | 主机卷挂载 | 技能级状态 |
| 代理工作区 | `/home/node/.openclaw/workspace/` | 主机卷挂载 | 代码和代理制品 |
| WhatsApp 会话 | `/home/node/.openclaw/` | 主机卷挂载 | 保留 QR 登录 |
| Gmail keyring | `/home/node/.openclaw/` | 主机卷 + 密码 | 需要 `GOG_KEYRING_PASSWORD` |
| 外部二进制文件 | `/usr/local/bin/` | Docker 镜像 | 必须在构建时烘焙 |
| Node 运行时 | 容器文件系统 | Docker 镜像 | 每次镜像构建时重新构建 |
| OS 包 | 容器文件系统 | Docker 镜像 | 不要在运行时安装 |
| Docker 容器 | 临时性 | 可重启 | 可以安全销毁 |

## 更新

更新 VM 上的 OpenClaw：

```bash
git pull
docker compose build
docker compose up -d
```