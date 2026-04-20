---
summary: "OpenClaw 的高级设置和开发工作流程"
read_when:
  - 设置新机器
  - 您想要“最新最好”的版本而不破坏个人设置
title: "设置"
---

# 设置

<Note>
如果您是第一次设置，请从 [入门](/start/getting-started) 开始。
有关引导流程的详细信息，请参阅 [引导（CLI）](/start/wizard)。
</Note>

## 快速概览

- **定制位于仓库外**：`~/.openclaw/workspace`（工作区）+ `~/.openclaw/openclaw.json`（配置）。
- **稳定工作流程**：安装 macOS 应用；让它运行捆绑的网关。
- **前沿工作流程**：通过 `pnpm gateway:watch` 自己运行网关，然后让 macOS 应用以本地模式附加。

## 先决条件（从源码）

- 推荐 Node 24（Node 22 LTS，当前 `22.14+`，仍然支持）
- 首选 `pnpm`（或 Bun，如果您有意使用 [Bun 工作流程](/install/bun)）
- Docker（可选；仅用于容器化设置/e2e — 请参阅 [Docker](/install/docker)）

## 定制策略（以便更新不会影响）

如果您想要“100% 为我定制”并且易于更新，请将您的定制保存在：

- **配置**：`~/.openclaw/openclaw.json`（JSON/JSON5 格式）
- **工作区**：`~/.openclaw/workspace`（技能、提示、记忆；将其设为私有 git 仓库）

引导一次：

```bash
openclaw setup
```

从这个仓库内部，使用本地 CLI 入口：

```bash
openclaw setup
```

如果您还没有全局安装，请通过 `pnpm openclaw setup` 运行它（如果使用 Bun 工作流程，则通过 `bun run openclaw setup`）。

## 从这个仓库运行网关

`pnpm build` 后，您可以直接运行打包的 CLI：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 稳定工作流程（macOS 应用优先）

1. 安装并启动 **OpenClaw.app**（菜单栏）。
2. 完成引导/权限清单（TCC 提示）。
3. 确保网关处于 **本地** 模式并运行（应用管理它）。
4. 链接表面（示例：WhatsApp）：

```bash
openclaw channels login
```

5. 健全性检查：

```bash
openclaw health
```

如果您的构建中没有引导流程：

- 运行 `openclaw setup`，然后 `openclaw channels login`，然后手动启动网关（`openclaw gateway`）。

## 前沿工作流程（终端中的网关）

目标：在 TypeScript 网关上工作，获得热重载，保持 macOS 应用 UI 附加。

### 0)（可选）也从源码运行 macOS 应用

如果您也想要前沿的 macOS 应用：

```bash
./scripts/restart-mac.sh
```

### 1) 启动开发网关

```bash
pnpm install
# 仅首次运行（或重置本地 OpenClaw 配置/工作区后）
pnpm openclaw setup
pnpm gateway:watch
```

`gateway:watch` 在监视模式下运行网关，并在相关源代码、
配置和捆绑插件元数据更改时重新加载。
`pnpm openclaw setup` 是新鲜 checkout 的一次性本地配置/工作区初始化步骤。
`pnpm gateway:watch` 不会重建 `dist/control-ui`，因此在 `ui/` 更改后重新运行 `pnpm ui:build`，或在开发控制 UI 时使用 `pnpm ui:dev`。

如果您有意使用 Bun 工作流程，等效命令是：

```bash
bun install
# 仅首次运行（或重置本地 OpenClaw 配置/工作区后）
bun run openclaw setup
bun run gateway:watch
```

### 2) 将 macOS 应用指向您正在运行的网关

在 **OpenClaw.app** 中：

- 连接模式：**本地**
  应用将附加到配置端口上运行的网关。

### 3) 验证

- 应用内网关状态应显示 **“使用现有网关 …”**
- 或通过 CLI：

```bash
openclaw health
```

### 常见陷阱

- **错误端口**：网关 WS 默认为 `ws://127.0.0.1:18789`；保持应用和 CLI 在同一端口。
- **状态存储位置**：
  - 频道/提供商状态：`~/.openclaw/credentials/`
  - 模型认证配置文件：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 会话：`~/.openclaw/agents/<agentId>/sessions/`
  - 日志：`/tmp/openclaw/`

## 凭证存储映射

在调试认证或决定备份内容时使用：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 机器人令牌**：配置/env 或 `channels.telegram.tokenFile`（仅常规文件；拒绝符号链接）
- **Discord 机器人令牌**：配置/env 或 SecretRef（env/file/exec 提供商）
- **Slack 令牌**：配置/env (`channels.slack.*`)
- **配对允许列表**：
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（默认账户）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（非默认账户）
- **模型认证配置文件**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **文件支持的密钥有效负载（可选）**：`~/.openclaw/secrets.json`
- **旧版 OAuth 导入**：`~/.openclaw/credentials/oauth.json`
  更多详情：[安全](/gateway/security#credential-storage-map)。

## 更新（不破坏您的设置）

- 将 `~/.openclaw/workspace` 和 `~/.openclaw/` 保留为“您的东西”；不要将个人提示/配置放入 `openclaw` 仓库。
- 更新源码：`git pull` + 您选择的包管理器安装步骤（默认 `pnpm install`；Bun 工作流程为 `bun install`）+ 继续使用匹配的 `gateway:watch` 命令。

## Linux（systemd 用户服务）

Linux 安装使用 systemd **用户** 服务。默认情况下，systemd 在注销/空闲时停止用户
服务，这会杀死网关。引导流程会尝试为您启用逗留（可能会提示 sudo）。如果它仍然关闭，请运行：

```bash
sudo loginctl enable-linger $USER
```

对于始终开启或多用户服务器，考虑使用 **系统** 服务而不是
用户服务（不需要逗留）。请参阅 [网关运行手册](/gateway) 了解 systemd 说明。

## 相关文档

- [网关运行手册](/gateway)（标志、监督、端口）
- [网关配置](/gateway/configuration)（配置模式 + 示例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回复标签 + replyToMode 设置）
- [OpenClaw 助手设置](/start/openclaw)
- [macOS 应用](/platforms/macos)（网关生命周期）
