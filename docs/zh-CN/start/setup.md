---
read_when:
  - 在新机器上进行设置
  - 你想要"最新最好的版本"同时不破坏你的个人配置
summary: 设置指南：在保持更新的同时维护你的个性化 OpenClaw 配置
title: 设置
x-i18n:
  generated_at: "2026-02-01T21:39:04Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b7f4bd657d0df4feb5035c9f5ee727f9c67b991e9cedfc7768f99d010553fa01
  source_path: start/setup.md
  workflow: 15
---

# 设置

最后更新：2026-01-01

## 简而言之

- **个性化配置存放在仓库之外：** `~/.openclaw/workspace`（工作区）+ `~/.openclaw/openclaw.json`（配置）。
- **稳定工作流：** 安装 macOS 应用；让它运行内置的 Gateway网关。
- **前沿工作流：** 自行通过 `pnpm gateway:watch` 运行 Gateway网关，然后让 macOS 应用以本地模式接入。

## 前置条件（从源码构建）

- Node `>=22`
- `pnpm`
- Docker（可选；仅用于容器化设置/端到端测试——参见 [Docker](/install/docker)）

## 个性化策略（让更新不会造成麻烦）

如果你想要"100% 按我的方式定制"*同时*方便更新，请将自定义内容放在：

- **配置：** `~/.openclaw/openclaw.json`（JSON/JSON5 风格）
- **工作区：** `~/.openclaw/workspace`（Skills、提示词、记忆；建议设为私有 git 仓库）

初始化一次：

```bash
openclaw setup
```

在本仓库内，使用本地 CLI 入口：

```bash
openclaw setup
```

如果你还没有全局安装，请通过 `pnpm openclaw setup` 运行。

## 稳定工作流（macOS 应用优先）

1. 安装并启动 **OpenClaw.app**（菜单栏）。
2. 完成新手引导/权限检查清单（TCC 授权提示）。
3. 确保 Gateway网关处于**本地**模式并正在运行（由应用管理）。
4. 关联聊天界面（示例：WhatsApp）：

```bash
openclaw channels login
```

5. 安装完整性检查：

```bash
openclaw health
```

如果你的版本中新手引导不可用：

- 运行 `openclaw setup`，然后 `openclaw channels login`，接着手动启动 Gateway网关（`openclaw gateway`）。

## 前沿工作流（在终端中运行 Gateway网关）

目标：开发 TypeScript Gateway网关，获得热重载，同时保持 macOS 应用界面接入。

### 0)（可选）同样从源码运行 macOS 应用

如果你也想让 macOS 应用使用最前沿版本：

```bash
./scripts/restart-mac.sh
```

### 1) 启动开发 Gateway网关

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 以监视模式运行 Gateway网关，TypeScript 文件变更时自动重载。

### 2) 将 macOS 应用指向你运行的 Gateway网关在 **OpenClaw.app** 中：

- 连接模式：**本地**
  应用将接入在配置端口上运行的 Gateway网关。

### 3) 验证

- 应用内 Gateway网关状态应显示 **"Using existing gateway …"**
- 或通过 CLI 验证：

```bash
openclaw health
```

### 常见陷阱

- **端口错误：** Gateway网关 WS 默认使用 `ws://127.0.0.1:18789`；保持应用 + CLI 使用相同端口。
- **状态存储位置：**
  - 凭据：`~/.openclaw/credentials/`
  - 会话：`~/.openclaw/agents/<agentId>/sessions/`
  - 日志：`/tmp/openclaw/`

## 凭据存储映射

在调试认证或决定备份内容时参考：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 机器人令牌**：配置/环境变量或 `channels.telegram.tokenFile`
- **Discord 机器人令牌**：配置/环境变量（尚不支持令牌文件）
- **Slack 令牌**：配置/环境变量（`channels.slack.*`）
- **配对允许列表**：`~/.openclaw/credentials/<channel>-allowFrom.json`
- **模型认证配置文件**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **旧版 OAuth 导入**：`~/.openclaw/credentials/oauth.json`
  更多详情：[安全](/gateway/security#credential-storage-map)。

## 更新（不破坏你的配置）

- 将 `~/.openclaw/workspace` 和 `~/.openclaw/` 视为"你的东西"；不要将个人提示词/配置放入 `openclaw` 仓库中。
- 更新源码：`git pull` + `pnpm install`（当 lockfile 变更时）+ 继续使用 `pnpm gateway:watch`。

## Linux（systemd 用户服务）

Linux 安装使用 systemd **用户**服务。默认情况下，systemd 在注销/空闲时会停止用户
服务，这会终止 Gateway网关。新手引导会尝试为你启用
持久化（可能提示输入 sudo 密码）。如果仍未开启，请运行：

```bash
sudo loginctl enable-linger $USER
```

对于常驻或多用户服务器，建议使用**系统**服务而非
用户服务（无需持久化）。参见 [Gateway网关运维手册](/gateway) 中的 systemd 说明。

## 相关文档

- [Gateway网关运维手册](/gateway)（标志、进程管理、端口）
- [Gateway网关配置](/gateway/configuration)（配置结构 + 示例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回复标签 + replyToMode 设置）
- [OpenClaw 助手设置](/start/openclaw)
- [macOS 应用](/platforms/macos)（Gateway网关生命周期）
