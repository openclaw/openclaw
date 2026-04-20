---
summary: "WhatsApp 群消息处理的行为和配置（mentionPatterns 在所有表面共享）"
read_when:
  - 更改群消息规则或提及
title: "群消息"
---

# 群消息（WhatsApp 网络频道）

目标：让 Clawd 坐在 WhatsApp 群组中，只有在被 ping 时才唤醒，并保持该线程与个人 DM 会话分开。

注意：`agents.list[].groupChat.mentionPatterns` 现在也被 Telegram/Discord/Slack/iMessage 使用；本文档重点关注 WhatsApp 特定的行为。对于多代理设置，按代理设置 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作为全局回退）。

## 当前实现（2025-12-03）

- 激活模式：`mention`（默认）或 `always`。`mention` 需要 ping（通过 `mentionedJids` 的真实 WhatsApp @-提及、安全的正则表达式模式或文本中任何位置的机器人 E.164）。`always` 会在每条消息上唤醒代理，但它应该只在能添加有意义价值时才回复；否则返回确切的静默令牌 `NO_REPLY` / `no_reply`。可以在配置中设置默认值（`channels.whatsapp.groups`），并通过 `/activation` 按群组覆盖。当设置 `channels.whatsapp.groups` 时，它也作为群组允许列表（包括 `"*"` 以允许所有）。
- 群组策略：`channels.whatsapp.groupPolicy` 控制是否接受群消息（`open|disabled|allowlist`）。`allowlist` 使用 `channels.whatsapp.groupAllowFrom`（回退：显式 `channels.whatsapp.allowFrom`）。默认值为 `allowlist`（在添加发送者之前被阻止）。
- 每群组会话：会话键看起来像 `agent:<agentId>:whatsapp:group:<jid>`，因此命令如 `/verbose on`、`/trace on` 或 `/think high`（作为独立消息发送）的作用域仅限于该群组；个人 DM 状态不受影响。群组线程跳过心跳。
- 上下文注入：**仅待处理**的群消息（默认 50），未触发运行，前缀为 `[Chat messages since your last reply - for context]`，触发行前缀为 `[Current message - respond to this]`。会话中已有的消息不会重新注入。
- 发送者显示：每个群组批次现在以 `[from: Sender Name (+E164)]` 结尾，以便 Pi 知道谁在说话。
- 临时/仅查看一次：我们在提取文本/提及之前解开这些，因此其中的 ping 仍然会触发。
- 群组系统提示：在群组会话的第一轮（以及每当 `/activation` 更改模式时），我们在系统提示中注入一个简短的说明，如 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 如果元数据不可用，我们仍然告诉代理这是群聊。

## 配置示例（WhatsApp）

在 `~/.openclaw/openclaw.json` 中添加 `groupChat` 块，以便即使 WhatsApp 在文本正文中剥离视觉 `@`，显示名称 ping 也能工作：

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
          mentionPatterns: ["@?openclaw", "\+?15555550123"],
        },
      },
    ],
  },
}
```

注意：

- 正则表达式不区分大小写，并使用与其他配置正则表达式表面相同的安全正则表达式护栏；无效模式和不安全的嵌套重复被忽略。
- 当有人点击联系人时，WhatsApp 仍然通过 `mentionedJids` 发送规范提及，因此数字回退很少需要，但是一个有用的安全网。

### 激活命令（仅限所有者）

使用群聊命令：

- `/activation mention`
- `/activation always`

只有所有者号码（来自 `channels.whatsapp.allowFrom`，或未设置时机器人自己的 E.164）可以更改此设置。在群组中发送 `/status` 作为独立消息以查看当前激活模式。

## 如何使用

1. 将您的 WhatsApp 账户（运行 OpenClaw 的账户）添加到群组。
2. 说 `@openclaw …`（或包含号码）。只有允许列表中的发送者可以触发它，除非您设置 `groupPolicy: "open"`。
3. 代理提示将包括最近的群组上下文以及尾随的 `[from: …]` 标记，以便它可以针对正确的人。
4. 会话级指令（`/verbose on`、`/trace on`、`/think high`、`/new` 或 `/reset`、`/compact`）仅适用于该群组的会话；将它们作为独立消息发送以便注册。您的个人 DM 会话保持独立。

## 测试/验证

- 手动冒烟测试：
  - 在群组中发送 `@openclaw` ping 并确认回复引用了发送者名称。
  - 发送第二次 ping 并验证历史块被包含，然后在下一轮清除。
- 检查网关日志（使用 `--verbose` 运行）以查看 `inbound web message` 条目，显示 `from: <groupJid>` 和 `[from: …]` 后缀。

## 已知注意事项

- 群组有意跳过心跳，以避免嘈杂的广播。
- 回声抑制使用组合的批处理字符串；如果您发送两次相同的文本而没有提及，只有第一次会得到响应。
- 会话存储条目将在会话存储中显示为 `agent:<agentId>:whatsapp:group:<jid>`（默认在 `~/.openclaw/agents/<agentId>/sessions/sessions.json`）；缺少条目只是意味着群组尚未触发运行。
- 群组中的打字指示器遵循 `agents.defaults.typingMode`（默认：未提及时报 `message`）。
