---
read_when:
  - 处理 WhatsApp/网页渠道行为或收件箱路由时
summary: WhatsApp（网页渠道）集成：登录、收件箱、回复、媒体和运维
title: WhatsApp
x-i18n:
  generated_at: "2026-02-01T20:00:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 44fd88f8e269284999e5a5a52b230edae6e6f978528dd298d6a5603d03c0c38d
  source_path: channels/whatsapp.md
  workflow: 14
---

# WhatsApp（网页渠道）

状态：仅支持通过 Baileys 的 WhatsApp Web。Gateway网关拥有会话。

## 快速设置（入门）

1. 如果可能，使用**单独的手机号码**（推荐）。
2. 在 `~/.openclaw/openclaw.json` 中配置 WhatsApp。
3. 运行 `openclaw channels login` 扫描二维码（已关联设备）。
4. 启动 Gateway网关。

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

- 单个 Gateway网关进程中支持多个 WhatsApp 账号（多账号）。
- 确定性路由：回复返回到 WhatsApp，无模型路由。
- 模型获得足够的上下文以理解引用回复。

## 配置写入

默认情况下，WhatsApp 允许通过 `/config set|unset` 触发配置更新写入（需要 `commands.config: true`）。

禁用方式：

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## 架构（职责划分）

- **Gateway网关** 拥有 Baileys socket 和收件箱循环。
- **CLI / macOS 应用** 与 Gateway网关通信；不直接使用 Baileys。
- **活跃监听器** 是出站发送的必要条件；否则发送会快速失败。

## 获取手机号码（两种模式）

WhatsApp 需要真实的手机号码进行验证。VoIP 和虚拟号码通常会被屏蔽。在 WhatsApp 上运行 OpenClaw 有两种支持的方式：

### 专用号码（推荐）

为 OpenClaw 使用**单独的手机号码**。最佳用户体验，干净的路由，无自聊天问题。理想设置：**备用/旧 Android 手机 + eSIM**。保持 Wi-Fi 和充电连接，通过二维码关联。

**WhatsApp Business：** 你可以在同一设备上使用不同号码的 WhatsApp Business。非常适合将个人 WhatsApp 分开 — 安装 WhatsApp Business 并在其中注册 OpenClaw 号码。

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
如果你想使用配对而非允许列表，将 `channels.whatsapp.dmPolicy` 设置为 `pairing`。未知发送者会收到配对码；通过以下命令批准：
`openclaw pairing approve whatsapp <code>`

### 个人号码（备选方案）

快速备选方案：在**你自己的号码**上运行 OpenClaw。给自己发消息（WhatsApp "给自己发消息"）进行测试，避免打扰联系人。在设置和实验期间，需要在主手机上读取验证码。**必须启用自聊天模式。**
当向导询问你的个人 WhatsApp 号码时，输入你将用来发消息的手机号（所有者/发送者），而不是助手号码。

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

当设置了 `messages.responsePrefix` 时，自聊天回复默认使用 `[{identity.name}]`（否则为 `[openclaw]`）。
如果 `messages.responsePrefix` 未设置，则使用默认值。显式设置可自定义或禁用前缀（使用 `""` 来移除）。

### 号码获取技巧

- **本国 eSIM**，来自你所在国家的移动运营商（最可靠）
  - 奥地利：[hot.at](https://www.hot.at)
  - 英国：[giffgaff](https://www.giffgaff.com) — 免费 SIM 卡，无合约
- **预付费 SIM 卡** — 便宜，只需接收一条验证短信

**避免使用：** TextNow、Google Voice、大多数"免费短信"服务 — WhatsApp 会积极屏蔽这些号码。

**提示：** 该号码只需接收一条验证短信。之后，WhatsApp Web 会话通过 `creds.json` 持久保存。

## 为什么不用 Twilio？

- 早期 OpenClaw 版本支持 Twilio 的 WhatsApp Business 集成。
- WhatsApp Business 号码不适合个人助手。
- Meta 强制执行 24 小时回复窗口；如果你在过去 24 小时内没有回复，商业号码无法发起新消息。
- 高频或"频繁"使用会触发激进的封禁，因为商业账号不适合发送大量个人助手消息。
- 结果：投递不可靠且频繁被封禁，因此已移除支持。

## 登录 + 凭证

- 登录命令：`openclaw channels login`（通过已关联设备扫描二维码）。
- 多账号登录：`openclaw channels login --account <id>`（`<id>` = `accountId`）。
- 默认账号（省略 `--account` 时）：如果存在则为 `default`，否则为第一个已配置的账号 ID（排序后）。
- 凭证存储在 `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`。
- 备份副本位于 `creds.json.bak`（损坏时恢复）。
- 旧版兼容：早期安装将 Baileys 文件直接存储在 `~/.openclaw/credentials/`。
- 注销：`openclaw channels logout`（或 `--account <id>`）删除 WhatsApp 认证状态（但保留共享的 `oauth.json`）。
- 已注销的 socket => 错误提示重新关联。

## 入站流程（私聊 + 群聊）

- WhatsApp 事件来自 `messages.upsert`（Baileys）。
- 收件箱监听器在关闭时解除绑定，以避免在测试/重启中累积事件处理器。
- 状态/广播聊天被忽略。
- 私聊使用 E.164 格式；群聊使用群组 JID。
- **私聊策略**：`channels.whatsapp.dmPolicy` 控制私聊访问（默认：`pairing`）。
  - 配对：未知发送者会收到配对码（通过 `openclaw pairing approve whatsapp <code>` 批准；码在 1 小时后过期）。
  - 开放：需要 `channels.whatsapp.allowFrom` 包含 `"*"`。
  - 你关联的 WhatsApp 号码被隐式信任，因此自消息跳过 `channels.whatsapp.dmPolicy` 和 `channels.whatsapp.allowFrom` 检查。

### 个人号码模式（备选方案）

如果你在**个人 WhatsApp 号码**上运行 OpenClaw，启用 `channels.whatsapp.selfChatMode`（参见上方示例配置）。

行为：

- 出站私聊消息不会触发配对回复（防止骚扰联系人）。
- 入站未知发送者仍遵循 `channels.whatsapp.dmPolicy`。
- 自聊天模式（allowFrom 包含你的号码）避免自动已读回执并忽略提及 JID。
- 非自聊天私聊会发送已读回执。

## 已读回执

默认情况下，Gateway网关会在接受入站 WhatsApp 消息后将其标记为已读（蓝色对勾）。

全局禁用：

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

按账号禁用：

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

备注：

- 自聊天模式始终跳过已读回执。

## WhatsApp 常见问题：发送消息 + 配对

**关联 WhatsApp 后，OpenClaw 会给随机联系人发消息吗？**
不会。默认私聊策略是**配对**，因此未知发送者只会收到配对码，其消息**不会被处理**。OpenClaw 只回复收到的聊天，或你显式触发的发送（智能体/CLI）。

**WhatsApp 上的配对是如何工作的？**
配对是针对未知发送者的私聊门控：

- 新发送者的首条私聊消息会返回一个短码（消息不会被处理）。
- 通过以下命令批准：`openclaw pairing approve whatsapp <code>`（用 `openclaw pairing list whatsapp` 列出）。
- 码在 1 小时后过期；每个渠道的待处理请求上限为 3 个。

**多人可以在同一个 WhatsApp 号码上使用不同的 OpenClaw 实例吗？**
可以，通过 `bindings` 将每个发送者路由到不同的智能体（peer `kind: "dm"`，发送者 E.164 如 `+15551234567`）。回复仍然来自**同一个 WhatsApp 账号**，且私聊会折叠到每个智能体的主会话，因此请使用**每人一个智能体**。私聊访问控制（`dmPolicy`/`allowFrom`）在每个 WhatsApp 账号级别是全局的。参见[多智能体路由](/concepts/multi-agent)。

**为什么向导要询问我的手机号码？**
向导使用它来设置你的**允许列表/所有者**，以便允许你自己的私聊消息。它不用于自动发送。如果你在个人 WhatsApp 号码上运行，使用相同的号码并启用 `channels.whatsapp.selfChatMode`。

## 消息标准化（模型看到的内容）

- `Body` 是当前消息正文及其信封。
- 引用回复上下文**始终附加**：
  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```
- 回复元数据也会设置：
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = 引用正文或媒体占位符
  - `ReplyToSender` = E.164（已知时）
- 纯媒体入站消息使用占位符：
  - `<media:image|video|audio|document|sticker>`

## 群聊

- 群聊映射到 `agent:<agentId>:whatsapp:group:<jid>` 会话。
- 群聊策略：`channels.whatsapp.groupPolicy = open|disabled|allowlist`（默认 `allowlist`）。
- 激活模式：
  - `mention`（默认）：需要 @提及或正则匹配。
  - `always`：始终触发。
- `/activation mention|always` 仅限所有者且必须作为独立消息发送。
- 所有者 = `channels.whatsapp.allowFrom`（未设置时为自身 E.164）。
- **历史注入**（仅待处理）：
  - 最近*未处理*的消息（默认 50 条）插入在：
    `[Chat messages since your last reply - for context]`（已在会话中的消息不会被重复注入）
  - 当前消息位于：
    `[Current message - respond to this]`
  - 发送者后缀附加：`[from: Name (+E164)]`
- 群聊元数据缓存 5 分钟（主题 + 参与者）。

## 回复投递（线程）

- WhatsApp Web 发送标准消息（当前 Gateway网关中无引用回复线程）。
- 此渠道忽略回复标签。

## 确认反应（收到消息时自动反应）

WhatsApp 可以在收到消息时立即自动发送表情反应，在机器人生成回复之前。这为用户提供即时反馈，表明其消息已收到。

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

- `emoji`（字符串）：用于确认的表情（例如 "👀"、"✅"、"📨"）。为空或省略 = 功能禁用。
- `direct`（布尔值，默认：`true`）：在私聊/私信 中发送反应。
- `group`（字符串，默认：`"mentions"`）：群聊行为：
  - `"always"`：对所有群聊消息做出反应（即使没有 @提及）
  - `"mentions"`：仅在机器人被 @提及时做出反应
  - `"never"`：从不在群聊中做出反应

**按账号覆盖：**

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

- 反应在收到消息时**立即**发送，在输入指示器或机器人回复之前。
- 在 `requireMention: false`（激活模式：always）的群组中，`group: "mentions"` 会对所有消息做出反应（不仅仅是 @提及）。
- 即发即忘：反应失败会被记录但不会阻止机器人回复。
- 群聊反应会自动包含参与者 JID。
- WhatsApp 忽略 `messages.ackReaction`；请改用 `channels.whatsapp.ackReaction`。

## 智能体工具（反应）

- 工具：`whatsapp`，使用 `react` 动作（`chatJid`、`messageId`、`emoji`，可选 `remove`）。
- 可选：`participant`（群聊发送者）、`fromMe`（对自己的消息做出反应）、`accountId`（多账号）。
- 反应移除语义：参见 [/tools/reactions](/tools/reactions)。
- 工具门控：`channels.whatsapp.actions.reactions`（默认：启用）。

## 限制

- 出站文本按 `channels.whatsapp.textChunkLimit` 分块（默认 4000）。
- 可选换行分块：设置 `channels.whatsapp.chunkMode="newline"` 在空行（段落边界）处分割，再进行长度分块。
- 入站媒体保存受 `channels.whatsapp.mediaMaxMb` 限制（默认 50 MB）。
- 出站媒体项受 `agents.defaults.mediaMaxMb` 限制（默认 5 MB）。

## 出站发送（文本 + 媒体）

- 使用活跃的网页监听器；如果 Gateway网关未运行则报错。
- 文本分块：每条消息最大 4k（可通过 `channels.whatsapp.textChunkLimit` 配置，可选 `channels.whatsapp.chunkMode`）。
- 媒体：
  - 支持图片/视频/音频/文档。
  - 音频以 PTT 发送；`audio/ogg` => `audio/ogg; codecs=opus`。
  - 仅第一个媒体项带字幕。
  - 媒体获取支持 HTTP(S) 和本地路径。
  - 动态 GIF：WhatsApp 期望带 `gifPlayback: true` 的 MP4 以实现内联循环播放。
    - CLI：`openclaw message send --media <mp4> --gif-playback`
    - Gateway网关：`send` 参数包含 `gifPlayback: true`

## 语音消息（PTT 音频）

WhatsApp 以**语音消息**（PTT 气泡）发送音频。

- 最佳效果：OGG/Opus。OpenClaw 将 `audio/ogg` 重写为 `audio/ogg; codecs=opus`。
- WhatsApp 忽略 `[[audio_as_voice]]`（音频已作为语音消息发送）。

## 媒体限制 + 优化

- 默认出站上限：5 MB（每个媒体项）。
- 覆盖：`agents.defaults.mediaMaxMb`。
- 图片会自动优化为 JPEG 以控制在上限内（缩放 + 质量扫描）。
- 超大媒体 => 错误；媒体回复回退为文本警告。

## 心跳

- **Gateway网关心跳** 记录连接健康状态（`web.heartbeatSeconds`，默认 60 秒）。
- **智能体心跳** 可按智能体配置（`agents.list[].heartbeat`）或通过
  `agents.defaults.heartbeat` 全局配置（未设置每智能体条目时的回退）。
  - 使用配置的心跳提示（默认：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）+ `HEARTBEAT_OK` 跳过行为。
  - 投递默认到最后使用的渠道（或已配置的目标）。

## 重连行为

- 退避策略：`web.reconnect`：
  - `initialMs`、`maxMs`、`factor`、`jitter`、`maxAttempts`。
- 如果达到 maxAttempts，网页监控停止（降级）。
- 已注销 => 停止并要求重新关联。

## 配置速查表

- `channels.whatsapp.dmPolicy`（私聊策略：pairing/allowlist/open/disabled）。
- `channels.whatsapp.selfChatMode`（同号设置；机器人使用你的个人 WhatsApp 号码）。
- `channels.whatsapp.allowFrom`（私聊允许列表）。WhatsApp 使用 E.164 手机号码（无用户名）。
- `channels.whatsapp.mediaMaxMb`（入站媒体保存上限）。
- `channels.whatsapp.ackReaction`（消息收到时的自动反应：`{emoji, direct, group}`）。
- `channels.whatsapp.accounts.<accountId>.*`（按账号设置 + 可选 `authDir`）。
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb`（按账号入站媒体上限）。
- `channels.whatsapp.accounts.<accountId>.ackReaction`（按账号确认反应覆盖）。
- `channels.whatsapp.groupAllowFrom`（群聊发送者允许列表）。
- `channels.whatsapp.groupPolicy`（群聊策略）。
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit`（群聊历史上下文；`0` 禁用）。
- `channels.whatsapp.dmHistoryLimit`（私聊历史限制，按用户轮数）。按用户覆盖：`channels.whatsapp.dms["<phone>"].historyLimit`。
- `channels.whatsapp.groups`（群聊允许列表 + 提及门控默认值；使用 `"*"` 允许全部）
- `channels.whatsapp.actions.reactions`（WhatsApp 工具反应门控）。
- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix`（入站前缀；按账号：`channels.whatsapp.accounts.<accountId>.messagePrefix`；已弃用：`messages.messagePrefix`）
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
- 故障排除指南：[Gateway网关故障排除](/gateway/troubleshooting)。

## 故障排除（快速）

**未关联 / 需要二维码登录**

- 症状：`channels status` 显示 `linked: false` 或警告"未关联"。
- 修复：在 Gateway网关主机上运行 `openclaw channels login` 并扫描二维码（WhatsApp → 设置 → 已关联设备）。

**已关联但断开连接 / 重连循环**

- 症状：`channels status` 显示 `running, disconnected` 或警告"已关联但断开连接"。
- 修复：`openclaw doctor`（或重启 Gateway网关）。如果问题持续，通过 `channels login` 重新关联并检查 `openclaw logs --follow`。

**Bun 运行时**

- **不推荐**使用 Bun。WhatsApp（Baileys）和 Telegram 在 Bun 上不稳定。
  请使用 **Node** 运行 Gateway网关。（参见入门指南运行时说明。）
