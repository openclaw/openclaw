---
read_when:
  - 设置新机器
  - 你想要"最新最好的"而不破坏你的个人设置
summary: 设置指南：在保持最新的同时保持你的 Activi 设置个性化
title: 设置
x-i18n:
  generated_at: "2026-02-03T07:54:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b7f4bd657d0df4feb5035c9f5ee727f9c67b991e9cedfc7768f99d010553fa01
  source_path: start/setup.md
  workflow: 15
---

# 设置

最后更新：2026-01-01

## 太长不看

- **个性化设置存放在仓库之外：** `~/.activi/workspace`（工作区）+ `~/.activi/activi.json`（配置）。
- **稳定工作流：** 安装 macOS 应用；让它运行内置的 Gateway 网关。
- **前沿工作流：** 通过 `pnpm gateway:watch` 自己运行 Gateway 网关，然后让 macOS 应用以本地模式连接。

## 先决条件（从源码）

- Node `>=22`
- `pnpm`
- Docker（可选；仅用于容器化设置/e2e — 参阅 [Docker](/install/docker)）

## 个性化策略（让更新不会造成问题）

如果你想要"100% 为我定制"*并且*易于更新，将你的自定义内容保存在：

- **配置：** `~/.activi/activi.json`（JSON/JSON5 格式）
- **工作区：** `~/.activi/workspace`（Skills、提示、记忆；将其设为私有 git 仓库）

引导一次：

```bash
activi setup
```

在此仓库内部，使用本地 CLI 入口：

```bash
activi setup
```

如果你还没有全局安装，通过 `pnpm activi setup` 运行它。

## 稳定工作流（macOS 应用优先）

1. 安装并启动 **Activi.app**（菜单栏）。
2. 完成新手引导/权限检查清单（TCC 提示）。
3. 确保 Gateway 网关是**本地**并正在运行（应用管理它）。
4. 链接表面（示例：WhatsApp）：

```bash
activi channels login
```

5. 完整性检查：

```bash
activi health
```

如果你的构建版本中没有新手引导：

- 运行 `activi setup`，然后 `activi channels login`，然后手动启动 Gateway 网关（`activi gateway`）。

## 前沿工作流（在终端中运行 Gateway 网关）

目标：开发 TypeScript Gateway 网关，获得热重载，保持 macOS 应用 UI 连接。

### 0)（可选）也从源码运行 macOS 应用

如果你也想让 macOS 应用保持前沿：

```bash
./scripts/restart-mac.sh
```

### 1) 启动开发 Gateway 网关

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 以监视模式运行 Gateway 网关，并在 TypeScript 更改时重新加载。

### 2) 将 macOS 应用指向你正在运行的 Gateway 网关

在 **Activi.app** 中：

- 连接模式：**本地**
  应用将连接到在配置端口上运行的 Gateway 网关。

### 3) 验证

- 应用内 Gateway 网关状态应显示 **"Using existing gateway …"**
- 或通过 CLI：

```bash
activi health
```

### 常见陷阱

- **端口错误：** Gateway 网关 WS 默认为 `ws://127.0.0.1:18789`；保持应用 + CLI 在同一端口上。
- **状态存储位置：**
  - 凭证：`~/.activi/credentials/`
  - 会话：`~/.activi/agents/<agentId>/sessions/`
  - 日志：`/tmp/activi/`

## 凭证存储映射

在调试认证或决定备份什么时使用此映射：

- **WhatsApp**：`~/.activi/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**：配置/环境变量或 `channels.telegram.tokenFile`
- **Discord bot token**：配置/环境变量（尚不支持令牌文件）
- **Slack tokens**：配置/环境变量（`channels.slack.*`）
- **配对允许列表**：`~/.activi/credentials/<channel>-allowFrom.json`
- **模型认证配置文件**：`~/.activi/agents/<agentId>/agent/auth-profiles.json`
- **旧版 OAuth 导入**：`~/.activi/credentials/oauth.json`
  更多详情：[安全](/gateway/security#credential-storage-map)。

## 更新（不破坏你的设置）

- 将 `~/.activi/workspace` 和 `~/.activi/` 保持为"你的东西"；不要将个人提示/配置放入 `activi` 仓库。
- 更新源码：`git pull` + `pnpm install`（当锁文件更改时）+ 继续使用 `pnpm gateway:watch`。

## Linux（systemd 用户服务）

Linux 安装使用 systemd **用户**服务。默认情况下，systemd 在注销/空闲时停止用户服务，这会终止 Gateway 网关。新手引导会尝试为你启用 lingering（可能提示 sudo）。如果仍然关闭，运行：

```bash
sudo loginctl enable-linger $USER
```

对于常驻或多用户服务器，考虑使用**系统**服务而不是用户服务（不需要 lingering）。参阅 [Gateway 网关运行手册](/gateway) 了解 systemd 说明。

## 相关文档

- [Gateway 网关运行手册](/gateway)（标志、监督、端口）
- [Gateway 网关配置](/gateway/configuration)（配置模式 + 示例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回复标签 + replyToMode 设置）
- [Activi 助手设置](/start/activi)
- [macOS 应用](/platforms/macos)（Gateway 网关生命周期）
