---
read_when:
  - 处理 WhatsApp/网页渠道行为或收件箱路由时
summary: WhatsApp（网页渠道）集成：登录、收件箱、回复、媒体和运维
title: WhatsApp
x-i18n:
  generated_at: "2026-02-03T07:46:24Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: 44fd88f8e269284999e5a5a52b230edae6e6f978528dd298d6a5603d03c0c38d
  source_path: channels/whatsapp.md
  workflow: 15
---

# WhatsApp（网页渠道）

状态：仅支持通过 Baileys 的 WhatsApp Web。Gateway 网关拥有会话。

## 快速设置（新手）

1. 如果可能，使用**单独的手机号码**（推荐）。
2. 在 `~/.openclaw/openclaw.json` 中配置 WhatsApp。
3. 运行 `openclaw channels login` 扫描二维码（关联设备）。
4. 启动 Gateway 网关。

最小配置：

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## 目标

- 在一个 Gateway 网关进程中支持多个 WhatsApp 账户（多账户）。
- 确定性路由：回复返回到 WhatsApp，无模型路由。
- 模型能看到足够的上下文来理解引用回复。

## 配置写入

默认情况下，WhatsApp 允许写入由 `/config set|unset` 触发的配置更新（需要 `commands.config: true`）。

禁用方式：

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## 架构（谁拥有什么）

- **Gateway 网关**拥有 Baileys socket 和收件箱循环。
- **CLI / macOS 应用**与 Gateway 网关通信；不直接使用 Baileys。
- 发送出站消息需要**活跃的监听器**；否则发送会快速失败。

## 获取手机号码（两种模式）

WhatsApp 需要真实手机号码进行验证。VoIP 和虚拟号码通常会被封锁。在 WhatsApp 上运行 OpenClaw 有两种支持的方式：

### 专用号码（推荐）

为 OpenClaw 使用**单独的手机号码**。最佳用户体验，清晰的路由，无自聊天怪异问题。理想设置：**备用/旧 Android 手机 + eSIM**。保持 Wi-Fi 和电源连接，通过二维码关联。

**WhatsApp Business：** 你可以在同一设备上使用不同号码的 WhatsApp Business。非常适合将个人 WhatsApp 分开——安装 WhatsApp Business 并在那里注册 OpenClaw 号码。

**示例配置（专用号码，单用户允许列表）：**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**配对模式（可选）：**
如果你想使用配对而不是允许列表，请将 `channels.whatsapp.dmPolicy` 设置为 `pairing`。未知发送者会收到配对码；使用以下命令批准：
`openclaw pairing approve whatsapp <code>`

### 个人号码（备选方案）

快速备选方案：在**你自己的号码**上运行 OpenClaw。给自己发消息（WhatsApp"给自己发消息"）进行测试，这样就不会打扰联系人。在设置和实验期间需要在主手机上阅读验证码。**必须启用自聊天模式。**
当向导询问你的个人 WhatsApp 号码时，输入你将用于发送消息的手机（所有者/发送者），而不是助手号码。

**示例配置（个人号码，自聊天）：**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

当设置了 `identity.name` 时，自聊天回复默认为 `[{identity.name}]`（否则为 `[openclaw]`），
前提是 `messages.responsePrefix` 未设置。明确设置它可以自定义或禁用
前缀（使用 `""` 来移除）。

### 号码获取提示

- **本地 eSIM** 来自你所在国家的移动运营商（最可靠）
  - 奥地利：[hot.at](https://www.hot.at)
  - 英国：[giffgaff](https://www.giffgaff.com) — 免费 SIM 卡，无合约
- **预付费 SIM 卡** — 便宜，只需接收一条验证短信

**避免：** TextNow、Google Voice、大多数"免费短信"服务——WhatsApp 会积极封锁这些。

**提示：** 该号码只需要接收一条验证短信。之后，WhatsApp Web 会话通过 `creds.json` 持久化。

## 为什么不用 Twilio？

- 早期 OpenClaw 版本支持 Twilio 的 WhatsApp Business 集成。
- WhatsApp Business 号码不适合个人助手。
- Meta 强制执行 24 小时回复窗口；如果你在过去 24 小时内没有回复，商业号码无法发起新消息。
- 高频或"频繁"使用会触发激进的封锁，因为商业账户不适合发送大量个人助手消息。
- 结果：投递不可靠且频繁被封锁，因此该支持已被移除。

## 登录 + 凭证

- 登录命令：`openclaw channels login`（通过关联设备扫描二维码）。
- 多账户登录：`openclaw channels login --account <id>`（`<id>` = `accountId`）。
- 默认账户（省略 `--account` 时）：如果存在则为 `default`，否则为第一个配置的账户 id（排序后）。
- 凭证存储在 `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`。
- 备份副本在 `creds.json.bak`（损坏时恢复）。
- 旧版兼容性：较旧的安装将 Baileys 文件直接存储在 `~/.openclaw/credentials/` 中。
- 登出：`openclaw channels logout`（或 `--account <id>`）删除 WhatsApp 认证状态（但保留共享的 `oauth.json`）。
- 已登出的 socket => 错误提示重新关联。

## 入站流程（私信 + 群组）

- WhatsApp 事件来自 `messages.upsert`（Baileys）。
- 收件箱监听器在关闭时分离，以避免在测试/重启时累积事件处理器。
- 状态/广播聊天被忽略。
- 直接聊天使用 E.164；群组使用群组 JID。
- **私信策略**：`channels.whatsapp.dmPolicy` 控制直接聊天访问（默认：`pairing`）。
  - 配对：未知发送者会收到配对码（通过 `openclaw pairing approve whatsapp <code>` 批准；码在 1 小时后过期）。
  - 开放：需要 `channels.whatsapp.allowFrom` 包含 `"*"`。
  - 你关联的 WhatsApp 号码是隐式信任的，因此自身消息会跳过 `channels.whatsapp.dmPolicy` 和 `channels.whatsapp.allowFrom` 检查。

### 个人号码模式（备选方案）

如果你在**个人 WhatsApp 号码**上运行 OpenClaw，请启用 `channels.whatsapp.selfChatMode`（见上面的示例）。

行为：

- 出站私信永远不会触发配对回复（防止打扰联系人）。
- 入站未知发送者仍遵循 `channels.whatsapp.dmPolicy`。
- 自聊天模式（allowFrom 包含你的号码）避免自动已读回执并忽略提及 JID。
- 非自聊天私信会发送已读回执。

## 已读回执

默认情况下，Gateway 网关在接受入站 WhatsApp 消息后将其标记为已读（蓝色勾号）。

全局禁用：

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

按账户禁用：

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

注意事项：

- 自聊天模式始终跳过已读回执。

## WhatsApp 常见问题：发送消息 + 配对

**当我关联 WhatsApp 时，OpenClaw 会给随机联系人发消息吗？**
不会。默认私信策略是**配对**，因此未知发送者只会收到配对码，他们的消息**不会被处理**。OpenClaw 只会回复它收到的聊天，或你明确触发的发送（智能体/CLI）。

**WhatsApp 上的配对是如何工作的？**
配对是未知发送者的私信门控：

- 来自新发送者的第一条私信返回一个短码（消息不会被处理）。
- 使用以下命令批准：`openclaw pairing approve whatsapp <code>`（使用 `openclaw pairing list whatsapp` 列出）。
- 码在 1 小时后过期；每个渠道的待处理请求上限为 3 个。

**多个人可以在一个 WhatsApp 号码上使用不同的 OpenClaw 实例吗？**
可以，通过 `bindings` 将每个发送者路由到不同的智能体（peer `kind: "dm"`，发送者 E.164 如 `+15551234567`）。回复仍然来自**同一个 WhatsApp 账户**，直接聊天会折叠到每个智能体的主会话，因此**每人使用一个智能体**。私信访问控制（`dmPolicy`/`allowFrom`）是每个 WhatsApp 账户全局的。参见[多智能体路由](/concepts/multi-agent)。

**为什么向导会询问我的手机号码？**
向导使用它来设置你的**允许列表/所有者**，以便允许你自己的私信。它不会用于自动发送。如果你在个人 WhatsApp 号码上运行，请使用相同的号码并启用 `channels.whatsapp.selfChatMode`。

## 消息规范化（模型看到的内容）

- `Body` 是带有信封的当前消息正文。
- 引用回复上下文**始终附加**：
  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```
- 回复元数据也会设置：
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = 引用正文或媒体占位符
  - `ReplyToSender` = 已知时为 E.164
- 纯媒体入站消息使用占位符：
  - `<media:image|video|audio|document|sticker>`

## 群组

- 群组映射到 `agent:<agentId>:whatsapp:group:<jid>` 会话。
- 群组策略：`channels.whatsapp.groupPolicy = open|disabled|allowlist`（默认 `allowlist`）。
- 激活模式：
  - `mention`（默认）：需要 @提及或正则匹配。
  - `always`：始终触发。
- `/activation mention|always` 仅限所有者，必须作为独立消息发送。
- 所有者 = `channels.whatsapp.allowFrom`（如果未设置则为自身 E.164）。
- **历史注入**（仅待处理）：
  - 最近*未处理*的消息（默认 50 条）插入在：
    `[Chat messages since your last reply - for context]`（已在会话中的消息不会重新注入）
  - 当前消息在：
    `[Current message - respond to this]`
  - 附加发送者后缀：`[from: Name (+E164)]`
- 群组元数据缓存 5 分钟（主题 + 参与者）。

## 回复投递（线程）

- WhatsApp Web 发送标准消息（当前 Gateway 网关无引用回复线程）。
- 此渠道忽略回复标签。

## 确认表情（收到时自动回应）

WhatsApp 可以在收到传入消息时立即自动发送表情回应，在机器人生成回复之前。这为用户提供即时反馈，表明他们的消息已收到。

**配置：**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**选项：**

- `emoji`（字符串）：用于确认的表情（例如"👀"、"✅"、"📨"）。为空或省略 = 功能禁用。
- `direct`（布尔值，默认：`true`）：在直接/私信聊天中发送表情回应。
- `group`（字符串，默认：`"mentions"`）：群聊行为：
  - `"always"`：对所有群消息做出回应（即使没有 @提及）
  - `"mentions"`：仅在机器人被 @提及时做出回应
  - `"never"`：从不在群组中做出回应

**按账户覆盖：**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**行为说明：**

- 表情回应在消息收到时**立即**发送，在输入指示器或机器人回复之前。
- 在 `requireMention: false`（激活：always）的群组中，`group: "mentions"` 会对所有消息做出回应（不仅仅是 @提及）。
- 即发即忘：表情回应失败会被记录但不会阻止机器人回复。
- 群组表情回应会自动包含参与者 JID。
- WhatsApp 忽略 `messages.ackReaction`；请改用 `channels.whatsapp.ackReaction`。

## 智能体工具（表情回应）

- 工具：`whatsapp`，带有 `react` 动作（`chatJid`、`messageId`、`emoji`，可选 `remove`）。
- 可选：`participant`（群组发送者）、`fromMe`（对自己的消息做出回应）、`accountId`（多账户）。
- 表情移除语义：参见 [/tools/reactions](/tools/reactions)。
- 工具门控：`channels.whatsapp.actions.reactions`（默认：启用）。

## 限制

- 出站文本按 `channels.whatsapp.textChunkLimit` 分块（默认 4000）。
- 可选换行分块：设置 `channels.whatsapp.chunkMode="newline"` 在长度分块之前按空行（段落边界）分割。
- 入站媒体保存受 `channels.whatsapp.mediaMaxMb` 限制（默认 50 MB）。
- 出站媒体项受 `agents.defaults.mediaMaxMb` 限制（默认 5 MB）。

## 出站发送（文本 + 媒体）

- 使用活跃的网页监听器；如果 Gateway 网关未运行则报错。
- 文本分块：每条消息最大 4k（可通过 `channels.whatsapp.textChunkLimit` 配置，可选 `channels.whatsapp.chunkMode`）。
- 媒体：
  - 支持图片/视频/音频/文档。
  - 音频作为 PTT 发送；`audio/ogg` => `audio/ogg; codecs=opus`。
  - 仅在第一个媒体项上添加标题。
  - 媒体获取支持 HTTP(S) 和本地路径。
  - 动画 GIF：WhatsApp 期望带有 `gifPlayback: true` 的 MP4 以实现内联循环。
    - CLI：`openclaw message send --media <mp4> --gif-playback`
    - Gateway 网关：`send` 参数包含 `gifPlayback: true`

## 语音消息（PTT 音频）

WhatsApp 将音频作为**语音消息**（PTT 气泡）发送。

- 最佳效果：OGG/Opus。OpenClaw 将 `audio/ogg` 重写为 `audio/ogg; codecs=opus`。
- WhatsApp 忽略 `[[audio_as_voice]]`（音频已作为语音消息发送）。

## 媒体限制 + 优化

- 默认出站上限：5 MB（每个媒体项）。
- 覆盖：`agents.defaults.mediaMaxMb`。
- 图片自动优化为上限以下的 JPEG（调整大小 + 质量扫描）。
- 超大媒体 => 错误；媒体回复降级为文本警告。

## 心跳

- **Gateway 网关心跳**记录连接健康状态（`web.heartbeatSeconds`，默认 60 秒）。
- **智能体心跳**可以按智能体配置（`agents.list[].heartbeat`）或通过
  `agents.defaults.heartbeat` 全局配置（当没有设置按智能体条目时的降级）。
  - 使用配置的心跳提示词（默认：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）+ `HEARTBEAT_OK` 跳过行为。
  - 投递默认为最后使用的渠道（或配置的目标）。

## 重连行为

- 退避策略：`web.reconnect`：
  - `initialMs`、`maxMs`、`factor`、`jitter`、`maxAttempts`。
- 如果达到 maxAttempts，网页监控停止（降级）。
- 已登出 => 停止并要求重新关联。

## 配置快速映射

- `channels.whatsapp.dmPolicy`（私信策略：pairing/allowlist/open/disabled）。
- `channels.whatsapp.selfChatMode`（同手机设置；机器人使用你的个人 WhatsApp 号码）。
- `channels.whatsapp.allowFrom`（私信允许列表）。WhatsApp 使用 E.164 手机号码（无用户名）。
- `channels.whatsapp.mediaMaxMb`（入站媒体保存上限）。
- `channels.whatsapp.ackReaction`（消息收到时的自动回应：`{emoji, direct, group}`）。
- `channels.whatsapp.accounts.<accountId>.*`（按账户设置 + 可选 `authDir`）。
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb`（按账户入站媒体上限）。
- `channels.whatsapp.accounts.<accountId>.ackReaction`（按账户确认回应覆盖）。
- `channels.whatsapp.groupAllowFrom`（群组发送者允许列表）。
- `channels.whatsapp.groupPolicy`（群组策略）。
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit`（群组历史上下文；`0` 禁用）。
- `channels.whatsapp.dmHistoryLimit`（私信历史限制，按用户轮次）。按用户覆盖：`channels.whatsapp.dms["<phone>"].historyLimit`。
- `channels.whatsapp.groups`（群组允许列表 + 提及门控默认值；使用 `"*"` 允许全部）
- `channels.whatsapp.actions.reactions`（门控 WhatsApp 工具表情回应）。
- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix`（入站前缀；按账户：`channels.whatsapp.accounts.<accountId>.messagePrefix`；已弃用：`messages.messagePrefix`）
- `messages.responsePrefix`（出站前缀）
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model`（可选覆盖）
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*`（按智能体覆盖）
- `session.*`（scope、idle、store、mainKey）
- `web.enabled`（为 false 时禁用渠道启动）
- `web.heartbeatSeconds`
- `web.reconnect.*`

## 日志 + 故障排除

- 子系统：`whatsapp/inbound`、`whatsapp/outbound`、`web-heartbeat`、`web-reconnect`。
- 日志文件：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（可配置）。
- 故障排除指南：[Gateway 网关故障排除](/gateway/troubleshooting)。

## 故障排除（快速）

**未关联 / 需要二维码登录**

- 症状：`channels status` 显示 `linked: false` 或警告"Not linked"。
- 修复：在 Gateway 网关主机上运行 `openclaw channels login` 并扫描二维码（WhatsApp → 设置 → 关联设备）。

**已关联但断开连接 / 重连循环**

- 症状：`channels status` 显示 `running, disconnected` 或警告"Linked but disconnected"。
- 修复：`openclaw doctor`（或重启 Gateway 网关）。如果问题持续，通过 `channels login` 重新关联并检查 `openclaw logs --follow`。

**Bun 运行时**

- **不推荐** Bun。WhatsApp（Baileys）和 Telegram 在 Bun 上不可靠。
  请使用 **Node** 运行 Gateway 网关。（参见入门指南运行时说明。）
