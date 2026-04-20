---
summary: "通过 BlueBubbles macOS 服务器的 iMessage（REST 发送/接收、打字、反应、配对、高级操作）。"
read_when:
  - 设置 BlueBubbles 通道
  - 故障排除 webhook 配对
  - 在 macOS 上配置 iMessage
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

状态：通过 HTTP 与 BlueBubbles macOS 服务器通信的捆绑插件。**推荐用于 iMessage 集成**，因为与传统的 imsg 通道相比，它具有更丰富的 API 和更简单的设置。

## 捆绑插件

当前的 OpenClaw 版本捆绑了 BlueBubbles，因此正常的打包构建不需要单独的 `openclaw plugins install` 步骤。

## 概述

- 通过 BlueBubbles 辅助应用在 macOS 上运行 ([bluebubbles.app](https://bluebubbles.app))。
- 推荐/测试：macOS Sequoia (15)。macOS Tahoe (26) 可以工作；当前在 Tahoe 上编辑功能损坏，群组图标更新可能报告成功但不同步。
- OpenClaw 通过其 REST API 与其通信 (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`)。
- 传入消息通过 webhooks 到达；传出回复、打字指示器、已读回执和轻触反应是 REST 调用。
- 附件和贴纸作为入站媒体被摄取（并在可能时呈现给代理）。
- 配对/允许列表的工作方式与其他通道相同 (`/channels/pairing` 等)，使用 `channels.bluebubbles.allowFrom` + 配对代码。
- 反应作为系统事件呈现，就像 Slack/Telegram 一样，因此代理可以在回复前"提及"它们。
- 高级功能：编辑、撤销发送、回复线程、消息效果、群组管理。

## 快速开始

1. 在你的 Mac 上安装 BlueBubbles 服务器（按照 [bluebubbles.app/install](https://bluebubbles.app/install) 的说明）。
2. 在 BlueBubbles 配置中，启用 web API 并设置密码。
3. 运行 `openclaw onboard` 并选择 BlueBubbles，或手动配置：

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. 将 BlueBubbles webhooks 指向你的网关（例如：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. 启动网关；它将注册 webhook 处理程序并开始配对。

安全注意事项：

- 始终设置 webhook 密码。
- Webhook 认证始终是必需的。OpenClaw 拒绝 BlueBubbles webhook 请求，除非它们包含与 `channels.bluebubbles.password` 匹配的密码/guid（例如 `?password=<password>` 或 `x-password`），无论环回/代理拓扑如何。
- 在读取/解析完整的 webhook 正文之前检查密码认证。

## 保持 Messages.app 活跃（VM / 无头设置）

一些 macOS VM / 始终开启的设置可能会导致 Messages.app 进入"空闲"状态（传入事件停止，直到应用程序被打开/置于前台）。一个简单的解决方法是**每 5 分钟戳一下 Messages**，使用 AppleScript + LaunchAgent。

### 1) 保存 AppleScript

将此保存为：

- `~/Scripts/poke-messages.scpt`

示例脚本（非交互式；不窃取焦点）：

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- 触摸脚本接口以保持进程响应。
    set _chatCount to (count of chats)
  end tell
on error
  -- 忽略瞬时故障（首次运行提示、锁定会话等）。
end try
```

### 2) 安装 LaunchAgent

将此保存为：

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

注意：

- 这**每 300 秒**运行一次，并且**在登录时**运行。
- 第一次运行可能会触发 macOS **自动化**提示（`osascript` → Messages）。在运行 LaunchAgent 的同一用户会话中批准它们。

加载它：

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 入门

BlueBubbles 在交互式入门中可用：

```
openclaw onboard
```

向导提示输入：

- **服务器 URL**（必需）：BlueBubbles 服务器地址（例如，`http://192.168.1.100:1234`）
- **密码**（必需）：BlueBubbles 服务器设置中的 API 密码
- **Webhook 路径**（可选）：默认为 `/bluebubbles-webhook`
- **DM 策略**：配对、允许列表、开放或禁用
- **允许列表**：电话号码、电子邮件或聊天目标

你也可以通过 CLI 添加 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 访问控制（DMs + 群组）

DMs：

- 默认：`channels.bluebubbles.dmPolicy = "pairing"`。
- 未知发送者会收到配对代码；消息在批准之前被忽略（代码在 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 配对是默认的令牌交换。详情：[配对](/channels/pairing)

群组：

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（默认：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom` 控制当设置为 `allowlist` 时谁可以在群组中触发。

### 联系人姓名丰富（macOS，可选）

BlueBubbles 群组 webhooks 通常只包含原始参与者地址。如果你希望 `GroupMembers` 上下文显示本地联系人姓名，可以选择在 macOS 上启用本地联系人丰富：

- `channels.bluebubbles.enrichGroupParticipantsFromContacts = true` 启用查找。默认：`false`。
- 查找仅在群组访问、命令授权和提及门控允许消息通过后运行。
- 仅丰富未命名的电话参与者。
- 当没有找到本地匹配项时，原始电话号码仍然作为回退。

```json5
{
  channels: {
    bluebubbles: {
      enrichGroupParticipantsFromContacts: true,
    },
  },
}
```

### 提及门控（群组）

BlueBubbles 支持群组聊天的提及门控，与 iMessage/WhatsApp 行为匹配：

- 使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）检测提及。
- 当为群组启用 `requireMention` 时，代理仅在被提及时响应。
- 来自授权发送者的控制命令绕过提及门控。

按群组配置：

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // 所有群组的默认值
        "iMessage;-;chat123": { requireMention: false }, // 特定群组的覆盖
      },
    },
  },
}
```

### 命令门控

- 控制命令（例如，`/config`、`/model`）需要授权。
- 使用 `allowFrom` 和 `groupAllowFrom` 确定命令授权。
- 授权发送者即使在群组中不提及也可以运行控制命令。

## ACP 对话绑定

BlueBubbles 聊天可以转换为持久的 ACP 工作区，而无需更改传输层。

快速操作员流程：

- 在 DM 或允许的群组聊天中运行 `/acp spawn codex --bind here`。
- 该 BlueBubbles 对话中的未来消息将路由到生成的 ACP 会话。
- `/new` 和 `/reset` 原地重置相同的绑定 ACP 会话。
- `/acp close` 关闭 ACP 会话并移除绑定。

通过顶级 `bindings[]` 条目也支持配置的持久绑定，其中 `type: "acp"` 和 `match.channel: "bluebubbles"`。

`match.peer.id` 可以使用任何支持的 BlueBubbles 目标形式：

- 规范化的 DM 句柄，如 `+15555550123` 或 `user@example.com`
- `chat_id:<id>`
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

对于稳定的群组绑定，首选 `chat_id:*` 或 `chat_identifier:*`。

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
        channel: "bluebubbles",
        accountId: "default",
        peer: { kind: "dm", id: "+15555550123" },
      },
      acp: { label: "codex-imessage" },
    },
  ],
}
```

有关共享 ACP 绑定行为，请参阅 [ACP Agents](/tools/acp-agents)。

## 打字 + 已读回执

- **打字指示器**：在响应生成之前和期间自动发送。
- **已读回执**：由 `channels.bluebubbles.sendReadReceipts` 控制（默认：`true`）。
- **打字指示器**：OpenClaw 发送打字开始事件；BlueBubbles 在发送或超时时自动清除打字（通过 DELETE 手动停止不可靠）。

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // 禁用已读回执
    },
  },
}
```

## 高级操作

当在配置中启用时，BlueBubbles 支持高级消息操作：

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // 轻触反应（默认：true）
        edit: true, // 编辑已发送消息（macOS 13+，在 macOS 26 Tahoe 上损坏）
        unsend: true, // 撤销发送消息（macOS 13+）
        reply: true, // 按消息 GUID 回复线程
        sendWithEffect: true, // 消息效果（slam、loud 等）
        renameGroup: true, // 重命名群组聊天
        setGroupIcon: true, // 设置群组聊天图标/照片（在 macOS 26 Tahoe 上不稳定）
        addParticipant: true, // 向群组添加参与者
        removeParticipant: true, // 从群组移除参与者
        leaveGroup: true, // 离开群组聊天
        sendAttachment: true, // 发送附件/媒体
      },
    },
  },
}
```

可用操作：

- **react**：添加/移除轻触反应 (`messageId`, `emoji`, `remove`)
- **edit**：编辑已发送消息 (`messageId`, `text`)
- **unsend**：撤销发送消息 (`messageId`)
- **reply**：回复特定消息 (`messageId`, `text`, `to`)
- **sendWithEffect**：使用 iMessage 效果发送 (`text`, `to`, `effectId`)
- **renameGroup**：重命名群组聊天 (`chatGuid`, `displayName`)
- **setGroupIcon**：设置群组聊天的图标/照片 (`chatGuid`, `media`) — 在 macOS 26 Tahoe 上不稳定（API 可能返回成功但图标不同步）。
- **addParticipant**：向群组添加某人 (`chatGuid`, `address`)
- **removeParticipant**：从群组移除某人 (`chatGuid`, `address`)
- **leaveGroup**：离开群组聊天 (`chatGuid`)
- **upload-file**：发送媒体/文件 (`to`, `buffer`, `filename`, `asVoice`)
  - 语音备忘录：设置 `asVoice: true` 并使用 **MP3** 或 **CAF** 音频以 iMessage 语音消息形式发送。发送语音备忘录时，BlueBubbles 将 MP3 转换为 CAF。
- 旧别名：`sendAttachment` 仍然有效，但 `upload-file` 是规范的操作名称。

### 消息 ID（短 vs 完整）

OpenClaw 可能会显示**短**消息 ID（例如，`1`、`2`）以节省令牌。

- `MessageSid` / `ReplyToId` 可以是短 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含提供者的完整 ID。
- 短 ID 在内存中；它们可能在重启或缓存淘汰时过期。
- 操作接受短或完整的 `messageId`，但如果短 ID 不再可用，将会出错。

对于持久自动化和存储，使用完整 ID：

- 模板：`{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- 上下文：入站有效负载中的 `MessageSidFull` / `ReplyToIdFull`

有关模板变量，请参阅 [配置](/gateway/configuration)。

## 块流式传输

控制响应是作为单个消息发送还是分块流式传输：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // 启用块流式传输（默认关闭）
    },
  },
}
```

## 媒体 + 限制

- 入站附件被下载并存储在媒体缓存中。
- 通过 `channels.bluebubbles.mediaMaxMb` 限制入站和出站媒体（默认：8 MB）。
- 出站文本被分块为 `channels.bluebubbles.textChunkLimit`（默认：4000 字符）。

## 配置参考

完整配置：[配置](/gateway/configuration)

提供者选项：

- `channels.bluebubbles.enabled`：启用/禁用通道。
- `channels.bluebubbles.serverUrl`：BlueBubbles REST API 基础 URL。
- `channels.bluebubbles.password`：API 密码。
- `channels.bluebubbles.webhookPath`：Webhook 端点路径（默认：`/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`：`pairing | allowlist | open | disabled`（默认：`pairing`）。
- `channels.bluebubbles.allowFrom`：DM 允许列表（句柄、电子邮件、E.164 号码、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`：`open | allowlist | disabled`（默认：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom`：群发送者允许列表。
- `channels.bluebubbles.enrichGroupParticipantsFromContacts`：在 macOS 上，在门控通过后可选地从本地联系人丰富未命名的群组参与者。默认：`false`。
- `channels.bluebubbles.groups`：按群组配置（`requireMention` 等）。
- `channels.bluebubbles.sendReadReceipts`：发送已读回执（默认：`true`）。
- `channels.bluebubbles.blockStreaming`：启用块流式传输（默认：`false`；流式回复需要）。
- `channels.bluebubbles.textChunkLimit`：出站块大小（以字符为单位，默认：4000）。
- `channels.bluebubbles.chunkMode`：`length`（默认）仅在超过 `textChunkLimit` 时拆分；`newline` 在长度分块之前在空行（段落边界）处拆分。
- `channels.bluebubbles.mediaMaxMb`：入站/出站媒体限制（以 MB 为单位，默认：8）。
- `channels.bluebubbles.mediaLocalRoots`：允许用于出站本地媒体路径的绝对本地目录的显式允许列表。默认情况下，除非配置了此选项，否则本地路径发送被拒绝。每账户覆盖：`channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`。
- `channels.bluebubbles.historyLimit`：上下文的最大群组消息数（0 禁用）。
- `channels.bluebubbles.dmHistoryLimit`：DM 历史限制。
- `channels.bluebubbles.actions`：启用/禁用特定操作。
- `channels.bluebubbles.accounts`：多账户配置。

相关全局选项：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## 寻址 / 传递目标

首选 `chat_guid` 进行稳定路由：

- `chat_guid:iMessage;-;+15555550123`（群组首选）
- `chat_id:123`
- `chat_identifier:...`
- 直接句柄：`+15555550123`、`user@example.com`
  - 如果直接句柄没有现有的 DM 聊天，OpenClaw 将通过 `POST /api/v1/chat/new` 创建一个。这需要启用 BlueBubbles Private API。

## 安全

- Webhook 请求通过将 `guid`/`password` 查询参数或标头与 `channels.bluebubbles.password` 进行比较来进行认证。
- 保持 API 密码和 webhook 端点的秘密（将它们视为凭证）。
- BlueBubbles webhook 认证没有 localhost 绕过。如果你代理 webhook 流量，请在请求端到端保持 BlueBubbles 密码。`gateway.trustedProxies` 在此处不能替代 `channels.bluebubbles.password`。请参阅 [网关安全](/gateway/security#reverse-proxy-configuration)。
- 如果将 BlueBubbles 服务器暴露在 LAN 外，请启用 HTTPS + 防火墙规则。

## 故障排除

- 如果打字/已读事件停止工作，请检查 BlueBubbles webhook 日志并验证网关路径是否与 `channels.bluebubbles.webhookPath` 匹配。
- 配对代码在一小时后过期；使用 `openclaw pairing list bluebubbles` 和 `openclaw pairing approve bluebubbles <code>`。
- 反应需要 BlueBubbles 私有 API (`POST /api/v1/message/react`)；确保服务器版本公开它。
- 编辑/撤销发送需要 macOS 13+ 和兼容的 BlueBubbles 服务器版本。在 macOS 26 (Tahoe) 上，由于私有 API 更改，编辑当前已损坏。
- 群组图标更新在 macOS 26 (Tahoe) 上可能不稳定：API 可能返回成功但新图标不同步。
- OpenClaw 根据 BlueBubbles 服务器的 macOS 版本自动隐藏已知损坏的操作。如果在 macOS 26 (Tahoe) 上仍然显示编辑，请使用 `channels.bluebubbles.actions.edit=false` 手动禁用它。
- 有关状态/健康信息：`openclaw status --all` 或 `openclaw status --deep`。

有关一般通道工作流参考，请参阅 [通道](/channels) 和 [插件](/tools/plugin) 指南。

## 相关

- [通道概述](/channels) — 所有支持的通道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和加固
