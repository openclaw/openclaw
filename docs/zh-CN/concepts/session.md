---
read_when:
  - 修改会话处理或存储时
summary: 聊天的会话管理规则、键和持久化
title: 会话管理
x-i18n:
  generated_at: "2026-02-01T20:24:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 147c8d1a4b6b4864cb16ad942feba80181b6b0e29afa765e7958f8c2483746b5
  source_path: concepts/session.md
  workflow: 14
---

# 会话管理

OpenClaw 将**每个智能体一个私聊会话**视为主会话。私聊归并到 `agent:<agentId>:<mainKey>`（默认 `main`），而群组/频道聊天拥有各自独立的键。`session.mainKey` 会被遵循。

使用 `session.dmScope` 控制**私信**的分组方式：

- `main`（默认）：所有私信共享主会话以保持连续性。
- `per-peer`：按发送者 ID 跨渠道隔离。
- `per-channel-peer`：按渠道 + 发送者隔离（推荐用于多用户收件箱）。
- `per-account-channel-peer`：按账号 + 渠道 + 发送者隔离（推荐用于多账号收件箱）。
  使用 `session.identityLinks` 将带提供商前缀的对端 ID 映射到规范身份，这样在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 时，同一个人可以跨渠道共享私信会话。

## Gateway网关是权威数据源

所有会话状态均由 **Gateway网关**（"主" OpenClaw）管理。UI 客户端（macOS 应用、WebChat 等）必须向 Gateway网关查询会话列表和令牌计数，而不是读取本地文件。

- 在**远程模式**下，你关心的会话存储位于远程 Gateway网关主机上，而不是你的 Mac 上。
- UI 中显示的令牌计数来自 Gateway网关存储字段（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）。客户端不会解析 JSONL 记录来"修正"总数。

## 状态存储位置

- 在 **Gateway网关主机**上：
  - 存储文件：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（每个智能体）。
- 对话记录：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 话题会话使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 存储是一个 `sessionKey -> { sessionId, updatedAt, ... }` 的映射。删除条目是安全的；它们会按需重新创建。
- 群组条目可能包含 `displayName`、`channel`、`subject`、`room` 和 `space`，用于在 UI 中标记会话。
- 会话条目包含 `origin` 元数据（标签 + 路由提示），以便 UI 能够解释会话的来源。
- OpenClaw **不会**读取旧版 Pi/Tau 会话文件夹。

## 会话修剪

OpenClaw 默认在 LLM 调用之前从内存上下文中修剪**旧的工具结果**。
这**不会**重写 JSONL 历史记录。请参见 [/concepts/session-pruning](/concepts/session-pruning)。

## 压缩前记忆刷写

当会话接近自动压缩时，OpenClaw 可以运行一次**静默记忆刷写**轮次，提醒模型将持久笔记写入磁盘。这仅在工作区可写时运行。请参见[记忆](/concepts/memory)和[压缩](/concepts/compaction)。

## 传输层 → 会话键的映射

- 私聊遵循 `session.dmScope`（默认 `main`）。
  - `main`：`agent:<agentId>:<mainKey>`（跨设备/渠道保持连续性）。
    - 多个电话号码和渠道可以映射到同一个智能体主键；它们充当一个对话的传输通道。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId 默认为 `default`）。
  - 如果 `session.identityLinks` 匹配到带提供商前缀的对端 ID（例如 `telegram:123`），规范键将替换 `<peerId>`，使同一个人跨渠道共享会话。
- 群聊隔离状态：`agent:<agentId>:<channel>:group:<id>`（房间/频道使用 `agent:<agentId>:<channel>:channel:<id>`）。
  - Telegram 论坛话题在群组 ID 后附加 `:topic:<threadId>` 以实现隔离。
  - 旧版 `group:<id>` 键仍被识别以支持迁移。
- 入站上下文可能仍使用 `group:<id>`；渠道从 `Provider` 推断并规范化为 `agent:<agentId>:<channel>:group:<id>` 的规范形式。
- 其他来源：
  - 定时任务：`cron:<job.id>`
  - Webhook：`hook:<uuid>`（除非由 hook 显式设置）
  - 节点运行：`node-<nodeId>`

## 生命周期

- 重置策略：会话持续复用直到过期，过期在下一条入站消息时评估。
- 每日重置：默认为 **Gateway网关主机本地时间凌晨 4:00**。当会话的最后更新早于最近一次每日重置时间时，会话即为过期。
- 空闲重置（可选）：`idleMinutes` 添加一个滑动空闲窗口。当同时配置了每日重置和空闲重置时，**先到期的那个**强制创建新会话。
- 旧版仅空闲模式：如果设置了 `session.idleMinutes` 但没有任何 `session.reset`/`resetByType` 配置，OpenClaw 会保持仅空闲模式以向后兼容。
- 按类型覆盖（可选）：`resetByType` 允许你为 `dm`、`group` 和 `thread` 会话覆盖策略（thread = Slack/Discord 线程、Telegram 话题、连接器提供的 Matrix 线程）。
- 按渠道覆盖（可选）：`resetByChannel` 覆盖特定渠道的重置策略（适用于该渠道的所有会话类型，优先级高于 `reset`/`resetByType`）。
- 重置触发器：精确的 `/new` 或 `/reset`（加上 `resetTriggers` 中的额外项）会启动一个新的会话 ID，并将消息的剩余部分继续传递。`/new <model>` 接受模型别名、`provider/model` 或提供商名称（模糊匹配）来设置新会话的模型。如果单独发送 `/new` 或 `/reset`，OpenClaw 会运行一个简短的"问候"轮次来确认重置。
- 手动重置：从存储中删除特定键或移除 JSONL 记录；下一条消息会重新创建它们。
- 隔离的定时任务每次运行都会创建一个新的 `sessionId`（不复用空闲会话）。

## 发送策略（可选）

无需列出单个 ID 即可按特定会话类型阻止投递。

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

运行时覆盖（仅限所有者）：

- `/send on` → 允许此会话发送
- `/send off` → 禁止此会话发送
- `/send inherit` → 清除覆盖并使用配置规则
  请将这些作为独立消息发送以确保生效。

## 配置（可选的重命名示例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // 保持群组键独立
    dmScope: "main", // 私信连续性（共享收件箱请设置 per-channel-peer/per-account-channel-peer）
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // 默认值：mode=daily，atHour=4（Gateway网关主机本地时间）。
      // 如果同时设置了 idleMinutes，先到期的优先。
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
- `openclaw sessions --json` — 转储所有条目（使用 `--active <minutes>` 进行筛选）。
- `openclaw gateway call sessions.list --params '{}'` — 从运行中的 Gateway网关获取会话（使用 `--url`/`--token` 访问远程 Gateway网关）。
- 在聊天中发送 `/status` 作为独立消息，可查看智能体是否可达、会话上下文使用了多少、当前的思考/详细模式开关，以及 WhatsApp 网页凭证的最后刷新时间（有助于发现需要重新链接的情况）。
- 发送 `/context list` 或 `/context detail` 查看系统提示词和注入的工作区文件中的内容（以及最大的上下文贡献者）。
- 发送 `/stop` 作为独立消息，可中止当前运行、清除该会话的排队后续消息，并停止由其生成的任何子智能体运行（回复中包含已停止的数量）。
- 发送 `/compact`（可选指令）作为独立消息，可总结旧的上下文并释放窗口空间。请参见 [/concepts/compaction](/concepts/compaction)。
- JSONL 记录可以直接打开以查看完整的对话轮次。

## 提示

- 将主键专用于一对一对话；让群组保持各自独立的键。
- 自动化清理时，删除单个键而不是整个存储，以保留其他地方的上下文。

## 会话来源元数据

每个会话条目在 `origin` 中记录其来源（尽力而为）：

- `label`：人类可读标签（从对话标签 + 群组主题/频道解析）
- `provider`：规范化的渠道 ID（包括扩展）
- `from`/`to`：入站信封中的原始路由 ID
- `accountId`：提供商账号 ID（多账号时）
- `threadId`：渠道支持时的线程/话题 ID
  来源字段为私信、频道和群组填充。如果连接器仅更新投递路由（例如，保持私信主会话活跃），它仍应提供入站上下文，以便会话保留其说明性元数据。扩展可以通过在入站上下文中发送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 和 `SenderName`，并调用 `recordSessionMetaFromInbound`（或将相同的上下文传递给 `updateLastRoute`）来实现。
