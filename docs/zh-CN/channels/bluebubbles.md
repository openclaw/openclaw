---
read_when:
  - 设置 BlueBubbles 渠道
  - 排查 webhook 配对问题
  - 在 macOS 上配置 iMessage
summary: 通过 BlueBubbles macOS 服务器集成 iMessage（REST 发送/接收、输入状态、回应、配对、高级操作）。
title: BlueBubbles
x-i18n:
  generated_at: "2026-02-01T19:41:18Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: ac9a9d71f3bbc661da6cb2897ea32d290bbd16b35925250601cfff53bc85de8c
  source_path: channels/bluebubbles.md
  workflow: 14
---

# BlueBubbles（macOS REST）

状态：内置插件，通过 HTTP 与 BlueBubbles macOS 服务器通信。**推荐用于 iMessage 集成**，因为相比旧版 imsg 渠道，其 API 更丰富且更易于设置。

## 概述

- 通过 BlueBubbles 辅助应用在 macOS 上运行（[bluebubbles.app](https://bluebubbles.app)）。
- 推荐/已测试：macOS Sequoia (15)。macOS Tahoe (26) 可用；编辑功能目前在 Tahoe 上不可用，群组图标更新可能报告成功但不会同步。
- OpenClaw 通过其 REST API 与之通信（`GET /api/v1/ping`、`POST /message/text`、`POST /chat/:id/*`）。
- 收到的消息通过 webhooks 到达；发出的回复、输入指示器、已读回执和 tapback 回应均为 REST 调用。
- 附件和贴纸作为入站媒体被接收（在可能的情况下呈现给智能体）。
- 配对/允许列表与其他渠道的工作方式相同（`/start/pairing` 等），使用 `channels.bluebubbles.allowFrom` + 配对码。
- 回应作为系统事件呈现，与 Slack/Telegram 相同，因此智能体可以在回复前"提及"它们。
- 高级功能：编辑、撤回、回复线程、消息特效、群组管理。

## 快速开始

1. 在你的 Mac 上安装 BlueBubbles 服务器（按照 [bluebubbles.app/install](https://bluebubbles.app/install) 的说明操作）。
2. 在 BlueBubbles 配置中，启用 Web API 并设置密码。
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
4. 将 BlueBubbles webhooks 指向你的 Gateway网关（示例：`https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`）。
5. 启动 Gateway网关；它将注册 webhook 处理器并开始配对。

## 新手引导

BlueBubbles 可在交互式设置向导中使用：

```
openclaw onboard
```

向导会提示输入：

- **服务器 URL**（必填）：BlueBubbles 服务器地址（例如 `http://192.168.1.100:1234`）
- **密码**（必填）：来自 BlueBubbles 服务器设置的 API 密码
- **Webhook 路径**（可选）：默认为 `/bluebubbles-webhook`
- **私聊策略**：配对、允许列表、开放或禁用
- **允许列表**：电话号码、邮箱或聊天目标

你也可以通过 CLI 添加 BlueBubbles：

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 访问控制（私聊 + 群组）

私聊：

- 默认：`channels.bluebubbles.dmPolicy = "pairing"`。
- 未知发送者会收到配对码；消息在批准前会被忽略（配对码 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 配对是默认的令牌交换方式。详情：[配对](/start/pairing)

群组：

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled`（默认：`allowlist`）。
- 当设置为 `allowlist` 时，`channels.bluebubbles.groupAllowFrom` 控制谁可以在群组中触发。

### 提及门控（群组）

BlueBubbles 支持群聊的提及门控，与 iMessage/WhatsApp 行为一致：

- 使用 `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）检测提及。
- 当群组启用 `requireMention` 时，智能体仅在被提及时回复。
- 来自授权发送者的控制命令会绕过提及门控。

按群组配置：

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // 所有群组的默认值
        "iMessage;-;chat123": { requireMention: false }, // 针对特定群组的覆盖
      },
    },
  },
}
```

### 命令门控

- 控制命令（例如 `/config`、`/model`）需要授权。
- 使用 `allowFrom` 和 `groupAllowFrom` 来确定命令授权。
- 授权发送者即使在群组中未提及也可以运行控制命令。

## 输入状态 + 已读回执

- **输入指示器**：在生成回复前和生成过程中自动发送。
- **已读回执**：由 `channels.bluebubbles.sendReadReceipts` 控制（默认：`true`）。
- **输入指示器**：OpenClaw 发送输入开始事件；BlueBubbles 在发送或超时时自动清除输入状态（通过 DELETE 手动停止不可靠）。

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

在配置中启用后，BlueBubbles 支持高级消息操作：

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapback 回应（默认：true）
        edit: true, // 编辑已发送消息（macOS 13+，macOS 26 Tahoe 上不可用）
        unsend: true, // 撤回消息（macOS 13+）
        reply: true, // 按消息 GUID 回复线程
        sendWithEffect: true, // 消息特效（slam、loud 等）
        renameGroup: true, // 重命名群聊
        setGroupIcon: true, // 设置群聊图标/头像（macOS 26 Tahoe 上不稳定）
        addParticipant: true, // 向群组添加参与者
        removeParticipant: true, // 从群组移除参与者
        leaveGroup: true, // 离开群聊
        sendAttachment: true, // 发送附件/媒体
      },
    },
  },
}
```

可用操作：

- **react**：添加/移除 tapback 回应（`messageId`、`emoji`、`remove`）
- **edit**：编辑已发送的消息（`messageId`、`text`）
- **unsend**：撤回消息（`messageId`）
- **reply**：回复特定消息（`messageId`、`text`、`to`）
- **sendWithEffect**：使用 iMessage 特效发送（`text`、`to`、`effectId`）
- **renameGroup**：重命名群聊（`chatGuid`、`displayName`）
- **setGroupIcon**：设置群聊图标/头像（`chatGuid`、`media`）——在 macOS 26 Tahoe 上不稳定（API 可能返回成功但图标不会同步）。
- **addParticipant**：向群组添加成员（`chatGuid`、`address`）
- **removeParticipant**：从群组移除成员（`chatGuid`、`address`）
- **leaveGroup**：离开群聊（`chatGuid`）
- **sendAttachment**：发送媒体/文件（`to`、`buffer`、`filename`、`asVoice`）
  - 语音备忘录：设置 `asVoice: true` 并使用 **MP3** 或 **CAF** 音频以 iMessage 语音消息形式发送。BlueBubbles 在发送语音备忘录时会将 MP3 转换为 CAF。

### 消息 ID（短格式与完整格式）

OpenClaw 可能会呈现*短*消息 ID（例如 `1`、`2`）以节省 token。

- `MessageSid` / `ReplyToId` 可以是短 ID。
- `MessageSidFull` / `ReplyToIdFull` 包含提供商的完整 ID。
- 短 ID 存储在内存中；它们可能在重启或缓存清除后过期。
- 操作接受短格式或完整格式的 `messageId`，但如果短 ID 不再可用则会报错。

对于持久化自动化和存储，请使用完整 ID：

- 模板：`{{MessageSidFull}}`、`{{ReplyToIdFull}}`
- 上下文：入站负载中的 `MessageSidFull` / `ReplyToIdFull`

模板变量请参阅[配置](/gateway/configuration)。

## 分块流式传输

控制回复是作为单条消息发送还是分块流式传输：

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // 启用分块流式传输（默认行为）
    },
  },
}
```

## 媒体 + 限制

- 入站附件会被下载并存储在媒体缓存中。
- 媒体上限通过 `channels.bluebubbles.mediaMaxMb` 设置（默认：8 MB）。
- 出站文本按 `channels.bluebubbles.textChunkLimit` 进行分块（默认：4000 字符）。

## 配置参考

完整配置：[配置](/gateway/configuration)

提供商选项：

- `channels.bluebubbles.enabled`：启用/禁用渠道。
- `channels.bluebubbles.serverUrl`：BlueBubbles REST API 基础 URL。
- `channels.bluebubbles.password`：API 密码。
- `channels.bluebubbles.webhookPath`：Webhook 端点路径（默认：`/bluebubbles-webhook`）。
- `channels.bluebubbles.dmPolicy`：`pairing | allowlist | open | disabled`（默认：`pairing`）。
- `channels.bluebubbles.allowFrom`：私聊允许列表（句柄、邮箱、E.164 号码、`chat_id:*`、`chat_guid:*`）。
- `channels.bluebubbles.groupPolicy`：`open | allowlist | disabled`（默认：`allowlist`）。
- `channels.bluebubbles.groupAllowFrom`：群组发送者允许列表。
- `channels.bluebubbles.groups`：按群组配置（`requireMention` 等）。
- `channels.bluebubbles.sendReadReceipts`：发送已读回执（默认：`true`）。
- `channels.bluebubbles.blockStreaming`：启用分块流式传输（默认：`true`）。
- `channels.bluebubbles.textChunkLimit`：出站分块大小（字符数，默认：4000）。
- `channels.bluebubbles.chunkMode`：`length`（默认）仅在超过 `textChunkLimit` 时分割；`newline` 在空行（段落边界）处分割，然后再进行长度分块。
- `channels.bluebubbles.mediaMaxMb`：入站媒体上限（MB，默认：8）。
- `channels.bluebubbles.historyLimit`：用于上下文的最大群组消息数（0 表示禁用）。
- `channels.bluebubbles.dmHistoryLimit`：私聊历史限制。
- `channels.bluebubbles.actions`：启用/禁用特定操作。
- `channels.bluebubbles.accounts`：多账户配置。

相关全局选项：

- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）。
- `messages.responsePrefix`。

## 寻址/投递目标

推荐使用 `chat_guid` 以实现稳定路由：

- `chat_guid:iMessage;-;+15555550123`（群组推荐使用）
- `chat_id:123`
- `chat_identifier:...`
- 直接句柄：`+15555550123`、`user@example.com`
  - 如果直接句柄没有现有的私聊会话，OpenClaw 将通过 `POST /api/v1/chat/new` 创建一个。这需要启用 BlueBubbles Private API。

## 安全

- Webhook 请求通过将 `guid`/`password` 查询参数或请求头与 `channels.bluebubbles.password` 比较来进行认证。来自 `localhost` 的请求也会被接受。
- 请保密 API 密码和 webhook 端点（将其视为凭证）。
- localhost 信任意味着同主机的反向代理可能会无意间绕过密码。如果你为 Gateway网关设置了代理，请在代理层要求认证并配置 `gateway.trustedProxies`。参见 [Gateway网关安全](/gateway/security#reverse-proxy-configuration)。
- 如果将 BlueBubbles 服务器暴露到局域网外部，请启用 HTTPS + 防火墙规则。

## 故障排除

- 如果输入/已读事件停止工作，请检查 BlueBubbles webhook 日志并验证 Gateway网关路径是否与 `channels.bluebubbles.webhookPath` 匹配。
- 配对码在一小时后过期；使用 `openclaw pairing list bluebubbles` 和 `openclaw pairing approve bluebubbles <code>`。
- 回应功能需要 BlueBubbles private API（`POST /api/v1/message/react`）；请确保服务器版本已暴露该接口。
- 编辑/撤回需要 macOS 13+ 和兼容的 BlueBubbles 服务器版本。在 macOS 26（Tahoe）上，由于 private API 变更，编辑功能目前不可用。
- 群组图标更新在 macOS 26（Tahoe）上可能不稳定：API 可能返回成功但新图标不会同步。
- OpenClaw 会根据 BlueBubbles 服务器的 macOS 版本自动隐藏已知不可用的操作。如果编辑功能在 macOS 26（Tahoe）上仍然显示，请手动通过 `channels.bluebubbles.actions.edit=false` 禁用。
- 查看状态/健康信息：`openclaw status --all` 或 `openclaw status --deep`。

通用渠道工作流参考请参阅[渠道](/channels)和[插件](/plugins)指南。
