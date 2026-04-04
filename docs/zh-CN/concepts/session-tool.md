---
read_when:
  - 添加或修改会话工具时
summary: 用于列出会话、获取历史记录和发送跨会话消息的智能体会话工具
title: 会话工具
x-i18n:
  generated_at: "2026-02-03T07:46:54Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cb6e0982ebf507bcf9de4bb17719759c2b6d3e519731c845580a55279084e4c8
  source_path: concepts/session-tool.md
  workflow: 15
---

# 会话工具

目标：小型、不易误用的工具集，使智能体能够列出会话、获取历史记录并向另一个会话发送消息。

## 工具名称

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 键模型

- 主直接聊天桶始终是字面键 `"main"`（解析为当前智能体的主键）。
- 群聊使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>`（传递完整键）。
- 定时任务使用 `cron:<job.id>`。
- Hooks 使用 `hook:<uuid>`，除非明确设置。
- Node 会话使用 `node-<nodeId>`，除非明确设置。

`global` 和 `unknown` 是保留值，永远不会被列出。如果 `session.scope = "global"`，我们会将其别名为 `main` 用于所有工具，这样调用者永远不会看到 `global`。

## sessions_list

将会话列为行数组。

参数：

- `kinds?: string[]` 过滤器：`"main" | "group" | "cron" | "hook" | "node" | "other"` 中的任意一个
- `limit?: number` 最大行数（默认：服务器默认值，限制如 200）
- `activeMinutes?: number` 仅在 N 分钟内更新的会话
- `messageLimit?: number` 0 = 无消息（默认 0）；>0 = 包含最后 N 条消息

行为：

- `messageLimit > 0` 获取每个会话的 `chat.history` 并包含最后 N 条消息。
- 工具结果在列表输出中被过滤；使用 `sessions_history` 获取工具消息。
- 在**沙箱隔离**的智能体会话中运行时，会话工具默认为**仅生成的可见性**（见下文）。

行结构（JSON）：

- `key`：会话键（字符串）
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（如果可用的群组显示标签）
- `updatedAt`（毫秒）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（如果设置的会话覆盖）
- `lastChannel`、`lastTo`
- `deliveryContext`（可用时的规范化 `{ channel, to, accountId }`）
- `transcriptPath`（从存储目录 + sessionId 派生的尽力路径）
- `messages?`（仅当 `messageLimit > 0` 时）

## sessions_history

获取一个会话的记录。

参数：

- `sessionKey`（必填；接受会话键或来自 `sessions_list` 的 `sessionId`）
- `limit?: number` 最大消息数（服务器限制）
- `includeTools?: boolean`（默认 false）

行为：

- `includeTools=false` 过滤 `role: "toolResult"` 消息。
- 以原始记录格式返回消息数组。
- 当给定 `sessionId` 时，OpenClaw 将其解析为相应的会话键（缺失的 id 会报错）。

## sessions_send

向另一个会话发送消息。

参数：

- `sessionKey`（必填；接受会话键或来自 `sessions_list` 的 `sessionId`）
- `message`（必填）
- `timeoutSeconds?: number`（默认 >0；0 = 即发即忘）

行为：

- `timeoutSeconds = 0`：入队并返回 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：等待最多 N 秒完成，然后返回 `{ runId, status: "ok", reply }`。
- 如果等待超时：`{ runId, status: "timeout", error }`。运行继续；稍后调用 `sessions_history`。
- 如果运行失败：`{ runId, status: "error", error }`。
- 通告投递在主运行完成后运行，且为尽力而为；`status: "ok"` 不保证通告已投递。
- 通过 Gateway 网关 `agent.wait`（服务器端）等待，因此重连不会丢失等待。
- 智能体到智能体的消息上下文会为主运行注入。
- 主运行完成后，OpenClaw 运行**回复循环**：
  - 第 2 轮及以后在请求者和目标智能体之间交替。
  - 精确回复 `REPLY_SKIP` 以停止来回。
  - 最大轮数为 `session.agentToAgent.maxPingPongTurns`（0–5，默认 5）。
- 循环结束后，OpenClaw 运行**智能体到智能体通告步骤**（仅目标智能体）：
  - 精确回复 `ANNOUNCE_SKIP` 以保持静默。
  - 任何其他回复都会发送到目标渠道。
  - 通告步骤包括原始请求 + 第 1 轮回复 + 最新的来回回复。

## Channel 字段

- 对于群组，`channel` 是会话条目上记录的渠道。
- 对于直接聊天，`channel` 从 `lastChannel` 映射。
- 对于 cron/hook/node，`channel` 是 `internal`。
- 如果缺失，`channel` 是 `unknown`。

## 安全 / 发送策略

基于策略的按渠道/聊天类型阻止（不是按会话 id）。

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

运行时覆盖（按会话条目）：

- `sendPolicy: "allow" | "deny"`（未设置 = 继承配置）
- 可通过 `sessions.patch` 或仅所有者的 `/send on|off|inherit`（独立消息）设置。

执行点：

- `chat.send` / `agent`（Gateway 网关）
- 自动回复投递逻辑

## sessions_spawn

在隔离会话中生成子智能体运行，并将结果通告回请求者聊天渠道。

参数：

- `task`（必填）
- `label?`（可选；用于日志/UI）
- `agentId?`（可选；如果允许，在另一个智能体 id 下生成）
- `model?`（可选；覆盖子智能体模型；无效值会报错）
- `runTimeoutSeconds?`（默认 0；设置时，在 N 秒后中止子智能体运行）
- `cleanup?`（`delete|keep`，默认 `keep`）

允许列表：

- `agents.list[].subagents.allowAgents`：通过 `agentId` 允许的智能体 id 列表（`["*"]` 允许任意）。默认：仅请求者智能体。

发现：

- 使用 `agents_list` 发现哪些智能体 id 允许用于 `sessions_spawn`。

行为：

- 使用 `deliver: false` 启动新的 `agent:<agentId>:subagent:<uuid>` 会话。
- 子智能体默认使用完整工具集**减去会话工具**（可通过 `tools.subagents.tools` 配置）。
- 子智能体不允许调用 `sessions_spawn`（无子智能体 → 子智能体生成）。
- 始终非阻塞：立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 完成后，OpenClaw 运行子智能体**通告步骤**并将结果发布到请求者聊天渠道。
- 在通告步骤中精确回复 `ANNOUNCE_SKIP` 以保持静默。
- 通告回复规范化为 `Status`/`Result`/`Notes`；`Status` 来自运行时结果（不是模型文本）。
- 子智能体会话在 `agents.defaults.subagents.archiveAfterMinutes` 后自动归档（默认：60）。
- 通告回复包含统计行（运行时间、token 数、sessionKey/sessionId、记录路径和可选成本）。

## 沙箱会话可见性

沙箱隔离的会话可以使用会话工具，但默认情况下它们只能看到通过 `sessions_spawn` 生成的会话。

配置：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // 默认："spawned"
        sessionToolsVisibility: "spawned", // 或 "all"
      },
    },
  },
}
```
