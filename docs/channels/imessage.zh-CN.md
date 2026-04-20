---
summary: "通过 imsg（stdio 上的 JSON-RPC）的旧版 iMessage 支持。新设置应使用 BlueBubbles。"
read_when:
  - 设置 iMessage 支持
  - 调试 iMessage 发送/接收
title: "iMessage"
---

# iMessage（旧版：imsg）

<警告>
对于新的 iMessage 部署，请使用 <a href="/channels/bluebubbles">BlueBubbles</a>。

`imsg` 集成是旧版的，可能在未来版本中被移除。
</警告>

状态：旧版外部 CLI 集成。网关生成 `imsg rpc` 并通过 stdio 上的 JSON-RPC 通信（无单独的守护进程/端口）。

<卡片组列数={3}>
  <卡片标题="BlueBubbles（推荐）" 图标="message-circle" 链接="/channels/bluebubbles">
    新设置的首选 iMessage 路径。
  </卡片>
  <卡片标题="配对" 图标="link" 链接="/channels/pairing">
    iMessage 私信默认采用配对模式。
  </卡片>
  <卡片标题="配置参考" 图标="settings" 链接="/gateway/configuration-reference#imessage">
    完整的 iMessage 字段参考。
  </卡片>
</卡片组>

## 快速设置

<标签页>
  <标签标题="本地 Mac（快速路径）">
    <步骤>
      <步骤标题="安装并验证 imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </步骤>

      <步骤标题="配置 OpenClaw">

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

      </步骤>

      <步骤标题="启动网关">

```bash
openclaw gateway
```

      </步骤>

      <步骤标题="批准第一个私信配对（默认 dmPolicy）">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <代码>
```

        配对请求在 1 小时后过期。
      </步骤>
    </步骤>

  </标签>

  <标签标题="通过 SSH 的远程 Mac">
    OpenClaw 只需要兼容 stdio 的 `cliPath`，因此你可以将 `cliPath` 指向一个包装脚本，该脚本通过 SSH 连接到远程 Mac 并运行 `imsg`。

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    启用附件时的推荐配置：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // 用于 SCP 附件获取
      includeAttachments: true,
      // 可选：覆盖允许的附件根目录。
      // 默认包括 /Users/*/Library/Messages/Attachments
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    如果未设置 `remoteHost`，OpenClaw 会尝试通过解析 SSH 包装脚本来自动检测它。
    `remoteHost` 必须是 `host` 或 `user@host`（无空格或 SSH 选项）。
    OpenClaw 对 SCP 使用严格的主机密钥检查，因此中继主机密钥必须已存在于 `~/.ssh/known_hosts` 中。
    附件路径会根据允许的根目录（`attachmentRoots` / `remoteAttachmentRoots`）进行验证。

  </标签>
</标签页>

## 要求和权限（macOS）

- 运行 `imsg` 的 Mac 上必须登录 Messages。
- 运行 OpenClaw/`imsg` 的进程上下文需要完全磁盘访问权限（Messages 数据库访问）。
- 通过 Messages.app 发送消息需要自动化权限。

<提示>
权限是按进程上下文授予的。如果网关无头运行（LaunchAgent/SSH），在相同的上下文中运行一次性交互式命令来触发提示：

```bash
imsg chats --limit 1
# 或
imsg send <handle> "test"
```

</提示>

## 访问控制和路由

<标签页>
  <标签标题="私信策略">
    `channels.imessage.dmPolicy` 控制私信：

    - `pairing`（默认）
    - `allowlist`
    - `open`（需要 `allowFrom` 包含 `"*"`）
    - `disabled`

    允许列表字段：`channels.imessage.allowFrom`。

    允许列表条目可以是句柄或聊天目标（`chat_id:*`、`chat_guid:*`、`chat_identifier:*`）。

  </标签>

  <标签标题="群组策略 + 提及">
    `channels.imessage.groupPolicy` 控制群组处理：

    - `allowlist`（配置时默认）
    - `open`
    - `disabled`

    群组发送者允许列表：`channels.imessage.groupAllowFrom`。

    运行时回退：如果未设置 `groupAllowFrom`，iMessage 群组发送者检查会在可用时回退到 `allowFrom`。
    运行时注意：如果 `channels.imessage` 完全缺失，运行时会回退到 `groupPolicy="allowlist"` 并记录警告（即使设置了 `channels.defaults.groupPolicy`）。

    群组的提及门控：

    - iMessage 没有原生提及元数据
    - 提及检测使用正则表达式模式（`agents.list[].groupChat.mentionPatterns`，回退 `messages.groupChat.mentionPatterns`）
    - 没有配置模式时，无法强制执行提及门控

    来自授权发送者的控制命令可以绕过群组中的提及门控。

  </标签>

  <标签标题="会话和确定性回复">
    - 私信使用直接路由；群组使用群组路由。
    - 使用默认 `session.dmScope=main`，iMessage 私信会折叠到代理主会话中。
    - 群组会话是隔离的（`agent:<agentId>:imessage:group:<chat_id>`）。
    - 回复使用原始通道/目标元数据路由回 iMessage。

    类群组线程行为：

    一些多参与者 iMessage 线程可能以 `is_group=false` 到达。
    如果该 `chat_id` 在 `channels.imessage.groups` 下明确配置，OpenClaw 会将其视为群组流量（群组门控 + 群组会话隔离）。

  </标签>
</标签页>

## ACP 对话绑定

旧版 iMessage 聊天也可以绑定到 ACP 会话。

快速操作者流程：

- 在私信或允许的群组聊天中运行 `/acp spawn codex --bind here`。
- 该 iMessage 对话中的未来消息会路由到生成的 ACP 会话。
- `/new` 和 `/reset` 会在原地重置相同的绑定 ACP 会话。
- `/acp close` 会关闭 ACP 会话并移除绑定。

通过顶级 `bindings[]` 条目支持配置的持久绑定，其中 `type: "acp"` 和 `match.channel: "imessage"`。

`match.peer.id` 可以使用：

- 规范化的私信句柄，如 `+15555550123` 或 `user@example.com`
- `chat_id:<id>`（推荐用于稳定的群组绑定）
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

示例：

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: { agent: "codex", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "group", id: "chat_id:123" },
      },
      acp: { label: "codex-group" },
    },
  ],
}
```

有关共享 ACP 绑定行为，请参阅 [ACP 代理](/tools/acp-agents)。

## 部署模式

<手风琴组>
  <手风琴标题="专用机器人 macOS 用户（单独的 iMessage 身份）">
    使用专用的 Apple ID 和 macOS 用户，以便机器人流量与你的个人 Messages 配置文件隔离。

    典型流程：

    1. 创建/登录专用 macOS 用户。
    2. 在该用户中使用机器人 Apple ID 登录 Messages。
    3. 在该用户中安装 `imsg`。
    4. 创建 SSH 包装器，以便 OpenClaw 可以在该用户上下文中运行 `imsg`。
    5. 将 `channels.imessage.accounts.<id>.cliPath` 和 `.dbPath` 指向该用户配置文件。

    首次运行可能需要在该机器人用户会话中进行 GUI 批准（自动化 + 完全磁盘访问）。

  </手风琴>

  <手风琴标题="通过 Tailscale 的远程 Mac（示例）">
    常见拓扑：

    - 网关在 Linux/VM 上运行
    - iMessage + `imsg` 在你的 tailnet 中的 Mac 上运行
    - `cliPath` 包装器使用 SSH 运行 `imsg`
    - `remoteHost` 启用 SCP 附件获取

    示例：

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

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

    使用 SSH 密钥，以便 SSH 和 SCP 都是非交互式的。
    确保主机密钥首先被信任（例如 `ssh bot@mac-mini.tailnet-1234.ts.net`），以便填充 `known_hosts`。

  </手风琴>

  <手风琴标题="多账户模式">
    iMessage 支持 `channels.imessage.accounts` 下的每个账户配置。

    每个账户可以覆盖字段，如 `cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb`、历史设置和附件根允许列表。

  </手风琴>
</手风琴组>

## 媒体、分块和交付目标

<手风琴组>
  <手风琴标题="附件和媒体">
    - 入站附件摄取是可选的：`channels.imessage.includeAttachments`
    - 设置 `remoteHost` 时，可以通过 SCP 获取远程附件路径
    - 附件路径必须匹配允许的根目录：
      - `channels.imessage.attachmentRoots`（本地）
      - `channels.imessage.remoteAttachmentRoots`（远程 SCP 模式）
      - 默认根目录模式：`/Users/*/Library/Messages/Attachments`
    - SCP 使用严格的主机密钥检查（`StrictHostKeyChecking=yes`）
    - 出站媒体大小使用 `channels.imessage.mediaMaxMb`（默认 16 MB）
  </手风琴>

  <手风琴标题="出站分块">
    - 文本分块限制：`channels.imessage.textChunkLimit`（默认 4000）
    - 分块模式：`channels.imessage.chunkMode`
      - `length`（默认）
      - `newline`（段落优先分割）
  </手风琴>

  <手风琴标题="寻址格式">
    首选显式目标：

    - `chat_id:123`（推荐用于稳定路由）
    - `chat_guid:...`
    - `chat_identifier:...`

    也支持句柄目标：

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

```bash
imsg chats --limit 20
```

  </手风琴>
</手风琴组>

## 配置写入

iMessage 默认允许通道发起的配置写入（当 `commands.config: true` 时用于 `/config set|unset`）。

禁用：

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## 故障排除

<手风琴组>
  <手风琴标题="imsg 未找到或 RPC 不支持">
    验证二进制文件和 RPC 支持：

```bash
imsg rpc --help
openclaw channels status --probe
```

    如果探测报告 RPC 不支持，请更新 `imsg`。

  </手风琴>

  <手风琴标题="私信被忽略">
    检查：

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - 配对批准（`openclaw pairing list imessage`）

  </手风琴>

  <手风琴标题="群消息被忽略">
    检查：

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 允许列表行为
    - 提及模式配置（`agents.list[].groupChat.mentionPatterns`）

  </手风琴>

  <手风琴标题="远程附件失败">
    检查：

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - 来自网关主机的 SSH/SCP 密钥认证
    - 网关主机上的 `~/.ssh/known_hosts` 中存在主机密钥
    - 在运行 Messages 的 Mac 上的远程路径可读性

  </手风琴>

  <手风琴标题="错过 macOS 权限提示">
    在相同的用户/会话上下文中的交互式 GUI 终端中重新运行并批准提示：

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    确认运行 OpenClaw/`imsg` 的进程上下文已授予完全磁盘访问权限 + 自动化权限。

  </手风琴>
</手风琴组>

## 配置参考指针

- [配置参考 - iMessage](/gateway/configuration-reference#imessage)
- [网关配置](/gateway/configuration)
- [配对](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)

## 相关

- [通道概述](/channels) — 所有支持的通道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化