---
read_when:
  - 更改群组消息规则或提及方式时
summary: WhatsApp 群组消息处理的行为与配置（mentionPatterns 在各平台间共享）
title: 群组消息
x-i18n:
  generated_at: "2026-02-01T20:22:33Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 181a72f12f5021af77c2e4c913120f711e0c0bc271d218d75cb6fe80dab675bb
  source_path: concepts/group-messages.md
  workflow: 14
---

# 群组消息（WhatsApp 网页渠道）

目标：让 Clawd 驻留在 WhatsApp 群组中，仅在被提及时唤醒，并将该线程与个人私聊会话隔离。

注意：`agents.list[].groupChat.mentionPatterns` 现在也被 Telegram/Discord/Slack/iMessage 使用；本文档重点介绍 WhatsApp 特定的行为。对于多智能体配置，请为每个智能体设置 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作为全局回退）。

## 已实现的功能（2025-12-03）

- 激活模式：`mention`（默认）或 `always`。`mention` 需要一次提及（通过 `mentionedJids` 实现的 WhatsApp 原生 @提及、正则匹配，或消息文本中包含机器人的 E.164 号码）。`always` 会在每条消息时唤醒智能体，但智能体仅在能提供有价值的回复时才会响应；否则返回静默令牌 `NO_REPLY`。默认值可在配置中设置（`channels.whatsapp.groups`），也可通过 `/activation` 按群组覆盖。设置 `channels.whatsapp.groups` 后，它同时充当群组白名单（添加 `"*"` 以允许所有群组）。
- 群组策略：`channels.whatsapp.groupPolicy` 控制是否接受群组消息（`open|disabled|allowlist`）。`allowlist` 使用 `channels.whatsapp.groupAllowFrom`（回退：显式的 `channels.whatsapp.allowFrom`）。默认为 `allowlist`（在添加发送者之前将被阻止）。
- 按群组隔离会话：会话键格式为 `agent:<agentId>:whatsapp:group:<jid>`，因此 `/verbose on` 或 `/think high` 等命令（作为独立消息发送）仅作用于该群组；个人私聊状态不受影响。群组线程会跳过心跳。
- 上下文注入：**仅待处理的**群组消息（默认 50 条）——即未触发运行的消息——会以 `[Chat messages since your last reply - for context]` 为前缀注入，触发消息则以 `[Current message - respond to this]` 为前缀。已在会话中的消息不会被重复注入。
- 发送者标识：每个群组消息批次末尾会附加 `[from: Sender Name (+E164)]`，以便 Pi 知道发言者是谁。
- 阅后即焚/一次性查看消息：我们在提取文本/提及之前先解包这些消息，因此其中的提及仍然会触发。
- 群组系统提示词：在群组会话的第一轮（以及每次通过 `/activation` 更改模式时），我们会在系统提示词中注入一段简短说明，例如 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 如果元数据不可用，我们仍然会告知智能体这是一个群聊。

## 配置示例（WhatsApp）

在 `~/.openclaw/openclaw.json` 中添加 `groupChat` 块，以便在 WhatsApp 去除文本正文中可见的 `@` 时，显示名称提及仍然有效：

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

说明：

- 正则表达式不区分大小写；它们涵盖了 `@openclaw` 这样的显示名称提及，以及带或不带 `+`/空格的原始号码。
- 当用户点击联系人时，WhatsApp 仍会通过 `mentionedJids` 发送规范提及，因此号码回退方式很少需要，但作为安全保障很有用。

### 激活命令（仅限所有者）

使用群聊命令：

- `/activation mention`
- `/activation always`

只有所有者号码（来自 `channels.whatsapp.allowFrom`，未设置时使用机器人自身的 E.164 号码）可以更改此设置。在群组中发送 `/status` 作为独立消息即可查看当前激活模式。

## 使用方法

1. 将你的 WhatsApp 账号（运行 OpenClaw 的账号）添加到群组。
2. 发送 `@openclaw …`（或包含号码）。除非设置了 `groupPolicy: "open"`，否则只有白名单中的发送者才能触发。
3. 智能体提示词将包含最近的群组上下文以及末尾的 `[from: …]` 标记，以便它能回复正确的人。
4. 会话级指令（`/verbose on`、`/think high`、`/new` 或 `/reset`、`/compact`）仅适用于该群组的会话；请将它们作为独立消息发送以确保生效。你的个人私聊会话保持独立。

## 测试 / 验证

- 手动冒烟测试：
  - 在群组中发送 `@openclaw` 提及，确认回复中引用了发送者名称。
  - 再次发送提及，验证历史消息块已包含并在下一轮清除。
- 检查 Gateway网关日志（使用 `--verbose` 运行）查看 `inbound web message` 条目，确认其显示 `from: <groupJid>` 和 `[from: …]` 后缀。

## 已知注意事项

- 群组有意跳过心跳以避免嘈杂的广播。
- 回声抑制使用组合的批次字符串；如果你在没有提及的情况下发送两次相同文本，只有第一次会收到响应。
- 会话存储条目将以 `agent:<agentId>:whatsapp:group:<jid>` 的形式出现在会话存储中（默认为 `~/.openclaw/agents/<agentId>/sessions/sessions.json`）；缺少条目仅表示该群组尚未触发过运行。
- 群组中的输入指示器遵循 `agents.defaults.typingMode`（默认：未被提及时为 `message`）。
