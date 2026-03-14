---
read_when:
  - 修改会话处理或存储
summary: 聊天的会话管理规则、键和持久化
title: 会话管理
x-i18n:
  generated_at: "2026-02-03T07:47:44Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 147c8d1a4b6b4864cb16ad942feba80181b6b0e29afa765e7958f8c2483746b5
  source_path: concepts/session.md
  workflow: 15
---

# 会话管理

OpenClaw 将**每个智能体的一个直接聊天会话**视为主会话。直接聊天折叠为 `agent:<agentId>:<mainKey>`（默认 `main`），而群组/频道聊天获得各自的键。`session.mainKey` 会被遵循。

使用 `session.dmScope` 控制**私信**如何分组：

- `main`（默认）：所有私信共享主会话以保持连续性。
- `per-peer`：跨渠道按发送者 ID 隔离。
- `per-channel-peer`：按渠道 + 发送者隔离（推荐用于多用户收件箱）。
- `per-account-channel-peer`：按账户 + 渠道 + 发送者隔离（推荐用于多账户收件箱）。
  使用 `session.identityLinks` 将带提供商前缀的对等 ID 映射到规范身份，这样在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 时，同一个人可以跨渠道共享私信会话。

## Gateway 网关是唯一数据源

所有会话状态都**由 Gateway 网关拥有**（"主" OpenClaw）。UI 客户端（macOS 应用、WebChat 等）必须向 Gateway 网关查询会话列表和令牌计数，而不是读取本地文件。

- 在**远程模式**下，你关心的会话存储位于远程 Gateway 网关主机上，而不是你的 Mac 上。
- UI 中显示的令牌计数来自 Gateway 网关的存储字段（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）。客户端不会解析 JSONL 对话记录来"修正"总数。

## 状态存储位置

- 在 **Gateway 网关主机**上：
  - 存储文件：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（每个智能体）。
- 对话记录：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 话题会话使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 存储是一个映射 `sessionKey -> { sessionId, updatedAt, ... }`。删除条目是安全的；它们会按需重新创建。
- 群组条目可能包含 `displayName`、`channel`、`subject`、`room` 和 `space` 以在 UI 中标记会话。
- 会话条目包含 `origin` 元数据（标签 + 路由提示），以便 UI 可以解释会话的来源。
- OpenClaw **不**读取旧版 Pi/Tau 会话文件夹。

## 会话修剪

默认情况下，OpenClaw 在 LLM 调用之前从内存上下文中修剪**旧的工具结果**。
这**不会**重写 JSONL 历史记录。参见 [/concepts/session-pruning](/concepts/session-pruning)。

## 压缩前记忆刷新

当会话接近自动压缩时，OpenClaw 可以运行一个**静默记忆刷新**轮次，提醒模型将持久性笔记写入磁盘。这仅在工作区可写时运行。参见[记忆](/concepts/memory)和[压缩](/concepts/compaction)。

## 传输到会话键的映射

- 直接聊天遵循 `session.dmScope`（默认 `main`）。
  - `main`：`agent:<agentId>:<mainKey>`（跨设备/渠道的连续性）。
    - 多个电话号码和渠道可以映射到同一个智能体主键；它们作为进入同一个对话的传输通道。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId 默认为 `default`）。
  - 如果 `session.identityLinks` 匹配带提供商前缀的对等 ID（例如 `telegram:123`），则规范键替换 `<peerId>`，这样同一个人可以跨渠道共享会话。
- 群组聊天隔离状态：`agent:<agentId>:<channel>:group:<id>`（房间/频道使用 `agent:<agentId>:<channel>:channel:<id>`）。
  - Telegram 论坛话题在群组 ID 后附加 `:topic:<threadId>` 以进行隔离。
  - 旧版 `group:<id>` 键仍被识别以进行迁移。
- 入站上下文可能仍使用 `group:<id>`；渠道从 `Provider` 推断并规范化为规范的 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他来源：
  - 定时任务：`cron:<job.id>`
  - Webhooks：`hook:<uuid>`（除非由 hook 显式设置）
  - 节点运行：`node-<nodeId>`

## 生命周期

- 重置策略：会话被重用直到过期，过期在下一条入站消息时评估。
- 每日重置：默认为 **Gateway 网关主机本地时间凌晨 4:00**。当会话的最后更新早于最近的每日重置时间时，会话即为过期。
- 空闲重置（可选）：`idleMinutes` 添加一个滑动空闲窗口。当同时配置每日和空闲重置时，**先过期者**强制新会话。
- 旧版仅空闲模式：如果你设置了 `session.idleMinutes` 而没有任何 `session.reset`/`resetByType` 配置，OpenClaw 会保持仅空闲模式以保持向后兼容。
- 按类型覆盖（可选）：`resetByType` 允许你覆盖 `dm`、`group` 和 `thread` 会话的策略（thread = Slack/Discord 线程、Telegram 话题、连接器提供的 Matrix 线程）。
- 按渠道覆盖（可选）：`resetByChannel` 覆盖渠道的重置策略（适用于该渠道的所有会话类型，优先于 `reset`/`resetByType`）。
- 重置触发器：精确的 `/new` 或 `/reset`（加上 `resetTriggers` 中的任何额外项）启动新的会话 ID 并传递消息的其余部分。`/new <model>` 接受模型别名、`provider/model` 或提供商名称（模糊匹配）来设置新会话模型。如果单独发送 `/new` 或 `/reset`，OpenClaw 会运行一个简短的"问候"轮次来确认重置。
- 手动重置：从存储中删除特定键或删除 JSONL 对话记录；下一条消息会重新创建它们。
- 隔离的定时任务总是每次运行生成新的 `sessionId`（没有空闲重用）。

## 发送策略（可选）

阻止特定会话类型的投递，无需列出单个 ID。

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

运行时覆盖（仅所有者）：

- `/send on` → 为此会话允许
- `/send off` → 为此会话拒绝
- `/send inherit` → 清除覆盖并使用配置规则
  将这些作为独立消息发送以使其生效。

## 配置（可选重命名示例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## 检查

- `openclaw status` — 显示存储路径和最近的会话。
- `openclaw sessions --json` — 导出每个条目（使用 `--active <minutes>` 过滤）。
- `openclaw gateway call sessions.list --params '{}'` — 从运行中的 Gateway 网关获取会话（使用 `--url`/`--token` 进行远程 Gateway 网关访问）。
- 在聊天中单独发送 `/status` 消息可查看智能体是否可达、会话上下文使用了多少、当前的思考/详细模式开关，以及你的 WhatsApp Web 凭证上次刷新时间（有助于发现重新链接需求）。
- 发送 `/context list` 或 `/context detail` 查看系统提示中的内容和注入的工作区文件（以及最大的上下文贡献者）。
- 单独发送 `/stop` 消息可中止当前运行、清除该会话的排队后续操作，并停止从中生成的任何子智能体运行（回复包含已停止的数量）。
- 单独发送 `/compact`（可选指令）消息可总结旧上下文并释放窗口空间。参见 [/concepts/compaction](/concepts/compaction)。
- 可以直接打开 JSONL 对话记录查看完整轮次。

## 提示

- 将主键专用于 1:1 通信；让群组保留各自的键。
- 自动清理时，删除单个键而不是整个存储，以保留其他地方的上下文。

## 会话来源元数据

每个会话条目记录其来源（尽力而为）在 `origin` 中：

- `label`：人类可读标签（从对话标签 + 群组主题/频道解析）
- `provider`：规范化的渠道 ID（包括扩展）
- `from`/`to`：入站信封中的原始路由 ID
- `accountId`：提供商账户 ID（多账户时）
- `threadId`：渠道支持时的线程/话题 ID
  来源字段为私信、频道和群组填充。如果连接器仅更新投递路由（例如，保持私信主会话新鲜），它仍应提供入站上下文，以便会话保留其解释器元数据。扩展可以通过在入站上下文中发送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 和 `SenderName` 并调用 `recordSessionMetaFromInbound`（或将相同上下文传递给 `updateLastRoute`）来实现。
