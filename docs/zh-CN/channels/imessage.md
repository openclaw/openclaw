---
read_when:
  - 设置 iMessage 支持
  - 调试 iMessage 收发
summary: 通过 imsg（基于 stdio 的 JSON-RPC）实现 iMessage 支持、设置和 chat_id 路由
title: iMessage
x-i18n:
  generated_at: "2026-02-01T19:21:07Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bc19756a42ead80a0845f18c4830c3f1f40948f69b2b016a4026598cfb8fef0d
  source_path: channels/imessage.md
  workflow: 14
---

# iMessage（imsg）

状态：外部 CLI 集成。Gateway网关启动 `imsg rpc`（基于 stdio 的 JSON-RPC）。

## 快速设置（新手）

1. 确保此 Mac 上的"信息"已登录。
2. 安装 `imsg`：
   - `brew install steipete/tap/imsg`
3. 配置 OpenClaw 的 `channels.imessage.cliPath` 和 `channels.imessage.dbPath`。
4. 启动 Gateway网关并批准所有 macOS 提示（自动化 + 完全磁盘访问权限）。

最小配置：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## 它是什么

- 在 macOS 上由 `imsg` 支持的 iMessage 渠道。
- 确定性路由：回复始终发回 iMessage。
- 私信共享智能体的主会话；群组是隔离的（`agent:<agentId>:imessage:group:<chat_id>`）。
- 如果多参与者线程以 `is_group=false` 到达，你仍然可以通过 `chat_id` 使用 `channels.imessage.groups` 来隔离它（参见下方"类群组线程"）。

## 配置写入

默认情况下，iMessage 允许通过 `/config set|unset` 触发的配置更新写入（需要 `commands.config: true`）。

通过以下方式禁用：

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## 要求

- macOS 且"信息"已登录。
- OpenClaw + `imsg` 需要完全磁盘访问权限（访问 Messages 数据库）。
- 发送时需要自动化权限。
- `channels.imessage.cliPath` 可以指向任何代理 stdin/stdout 的命令（例如，通过 SSH 连接到另一台 Mac 并运行 `imsg rpc` 的包装脚本）。

## 设置（快速路径）

1. 确保此 Mac 上的"信息"已登录。
2. 配置 iMessage 并启动 Gateway网关。

### 专用机器人 macOS 用户（用于隔离身份）

如果你希望机器人从一个**独立的 iMessage 身份**发送消息（并保持你的个人"信息"整洁），请使用专用的 Apple ID + 专用的 macOS 用户。

1. 创建一个专用的 Apple ID（例如：`my-cool-bot@icloud.com`）。
   - Apple 可能需要手机号码进行验证/双重认证。
2. 创建一个 macOS 用户（例如：`openclawhome`）并登录。
3. 在该 macOS 用户中打开"信息"并使用机器人 Apple ID 登录 iMessage。
4. 启用远程登录（系统设置 → 通用 → 共享 → 远程登录）。
5. 安装 `imsg`：
   - `brew install steipete/tap/imsg`
6. 设置 SSH 使 `ssh <bot-macos-user>@localhost true` 无需密码即可工作。
7. 将 `channels.imessage.accounts.bot.cliPath` 指向一个以机器人用户身份运行 `imsg` 的 SSH 包装脚本。

首次运行注意事项：发送/接收可能需要在*机器人 macOS 用户*中进行 GUI 审批（自动化 + 完全磁盘访问权限）。如果 `imsg rpc` 看起来卡住或退出，请登录该用户（屏幕共享很有帮助），运行一次 `imsg chats --limit 1` / `imsg send ...`，批准提示，然后重试。

示例包装脚本（`chmod +x`）。将 `<bot-macos-user>` 替换为你的实际 macOS 用户名：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 先运行一次交互式 SSH 以接受主机密钥：
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

示例配置：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

对于单账户设置，使用扁平选项（`channels.imessage.cliPath`、`channels.imessage.dbPath`）而非 `accounts` 映射。

### 远程/SSH 变体（可选）

如果你想在另一台 Mac 上使用 iMessage，将 `channels.imessage.cliPath` 设置为通过 SSH 在远程 macOS 主机上运行 `imsg` 的包装脚本。OpenClaw 只需要 stdio。

示例包装脚本：

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**远程附件：** 当 `cliPath` 通过 SSH 指向远程主机时，Messages 数据库中的附件路径引用的是远程机器上的文件。OpenClaw 可以通过设置 `channels.imessage.remoteHost` 自动通过 SCP 获取这些文件：

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // 到远程 Mac 的 SSH 包装脚本
      remoteHost: "user@gateway-host", // 用于 SCP 文件传输
      includeAttachments: true,
    },
  },
}
```

如果未设置 `remoteHost`，OpenClaw 会尝试通过解析你包装脚本中的 SSH 命令来自动检测。建议显式配置以确保可靠性。

#### 通过 Tailscale 连接远程 Mac（示例）

如果 Gateway网关运行在 Linux 主机/虚拟机上但 iMessage 必须运行在 Mac 上，Tailscale 是最简单的桥接方案：Gateway网关通过 tailnet 与 Mac 通信，通过 SSH 运行 `imsg`，并通过 SCP 传回附件。

架构：

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway网关主机（Linux/VM）      │──────────────────────────────────▶│ 装有 Messages + imsg 的 Mac │
│ - openclaw gateway           │          SCP（附件）              │ - Messages 已登录         │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - 远程登录已启用          │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet（主机名或 100.x.y.z）
              ▼
        user@gateway-host
```

具体配置示例（Tailscale 主机名）：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

示例包装脚本（`~/.openclaw/scripts/imsg-ssh`）：

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

注意事项：

- 确保 Mac 已登录"信息"，且远程登录已启用。
- 使用 SSH 密钥使 `ssh bot@mac-mini.tailnet-1234.ts.net` 无需提示即可工作。
- `remoteHost` 应与 SSH 目标匹配，以便 SCP 可以获取附件。

多账户支持：使用 `channels.imessage.accounts`，每个账户配置独立选项和可选的 `name`。共享模式请参阅 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。不要提交 `~/.openclaw/openclaw.json`（它通常包含 token）。

## 访问控制（私信 + 群组）

私信：

- 默认：`channels.imessage.dmPolicy = "pairing"`。
- 未知发送者会收到配对码；在批准之前消息会被忽略（配对码 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- 配对是 iMessage 私信的默认令牌交换方式。详情：[配对](/start/pairing)

群组：

- `channels.imessage.groupPolicy = open | allowlist | disabled`。
- 当设置为 `allowlist` 时，`channels.imessage.groupAllowFrom` 控制谁可以在群组中触发。
- 提及门控使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`），因为 iMessage 没有原生提及元数据。
- 多智能体覆盖：在 `agents.list[].groupChat.mentionPatterns` 上设置每个智能体的模式。

## 工作原理（行为）

- `imsg` 流式传输消息事件；Gateway网关将其标准化为共享的渠道信封。
- 回复始终路由回同一个 chat id 或用户名。

## 类群组线程（`is_group=false`）

一些 iMessage 线程可能有多个参与者，但由于"信息"存储聊天标识符的方式，仍然以 `is_group=false` 到达。

如果你在 `channels.imessage.groups` 下显式配置了一个 `chat_id`，OpenClaw 会将该线程视为"群组"，用于：

- 会话隔离（独立的 `agent:<agentId>:imessage:group:<chat_id>` 会话键）
- 群组允许列表/提及门控行为

示例：

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

当你想为特定线程使用隔离的个性/模型时很有用（参见[多智能体路由](/concepts/multi-agent)）。有关文件系统隔离，请参阅[沙箱](/gateway/sandboxing)。

## 媒体 + 限制

- 通过 `channels.imessage.includeAttachments` 可选接收附件。
- 媒体上限通过 `channels.imessage.mediaMaxMb` 设置。

## 限制

- 出站文本按 `channels.imessage.textChunkLimit` 分块（默认 4000）。
- 可选的换行分块：设置 `channels.imessage.chunkMode="newline"` 在按长度分块之前按空行（段落边界）分割。
- 媒体上传上限由 `channels.imessage.mediaMaxMb` 限制（默认 16）。

## 寻址 / 投递目标

推荐使用 `chat_id` 进行稳定路由：

- `chat_id:123`（推荐）
- `chat_guid:...`
- `chat_identifier:...`
- 直接用户名：`imessage:+1555` / `sms:+1555` / `user@example.com`

列出聊天：

```
imsg chats --limit 20
```

## 配置参考（iMessage）

完整配置：[配置](/gateway/configuration)

提供商选项：

- `channels.imessage.enabled`：启用/禁用渠道启动。
- `channels.imessage.cliPath`：`imsg` 的路径。
- `channels.imessage.dbPath`：Messages 数据库路径。
- `channels.imessage.remoteHost`：当 `cliPath` 指向远程 Mac 时用于 SCP 附件传输的 SSH 主机（例如 `user@gateway-host`）。未设置时从 SSH 包装脚本自动检测。
- `channels.imessage.service`：`imessage | sms | auto`。
- `channels.imessage.region`：SMS 区域。
- `channels.imessage.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）。
- `channels.imessage.allowFrom`：私信允许列表（用户名、邮箱、E.164 号码或 `chat_id:*`）。`open` 需要 `"*"`。iMessage 没有用户名；使用用户名或聊天目标。
- `channels.imessage.groupPolicy`：`open | allowlist | disabled`（默认：allowlist）。
- `channels.imessage.groupAllowFrom`：群组发送者允许列表。
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`：包含为上下文的最大群组消息数（0 禁用）。
- `channels.imessage.dmHistoryLimit`：私信历史限制（用户回合数）。按用户覆盖：`channels.imessage.dms["<handle>"].historyLimit`。
- `channels.imessage.groups`：按群组默认值 + 允许列表（使用 `"*"` 设置全局默认值）。
- `channels.imessage.includeAttachments`：将附件接收到上下文中。
- `channels.imessage.mediaMaxMb`：入站/出站媒体上限（MB）。
- `channels.imessage.textChunkLimit`：出站分块大小（字符）。
- `channels.imessage.chunkMode`：`length`（默认）或 `newline`，在按长度分块之前按空行（段落边界）分割。

相关全局选项：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。
