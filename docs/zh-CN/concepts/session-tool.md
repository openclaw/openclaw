---
read_when:
  - 添加或修改会话工具
summary: 智能体会话工具：列出会话、获取历史记录和发送跨会话消息
title: 会话工具
x-i18n:
  generated_at: "2026-02-01T20:24:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cb6e0982ebf507bcf9de4bb17719759c2b6d3e519731c845580a55279084e4c8
  source_path: concepts/session-tool.md
  workflow: 14
---

# 会话工具

目标：提供小型、不易误用的工具集，使智能体能够列出会话、获取历史记录以及向其他会话发送消息。

## 工具名称

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 键模型

- 主私聊桶始终使用字面键 `"main"`（解析为当前智能体的主键）。
- 群聊使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>`（传入完整键）。
- 定时任务使用 `cron:<job.id>`。
- 钩子使用 `hook:<uuid>`，除非显式设置。
- 节点会话使用 `node-<nodeId>`，除非显式设置。

`global` 和 `unknown` 是保留值，永远不会被列出。如果 `session.scope = "global"`，我们会将其别名为 `main` 供所有工具使用，这样调用方永远看不到 `global`。

## sessions_list

以行数组形式列出会话。

参数：

- `kinds?: string[]` 过滤器：`"main" | "group" | "cron" | "hook" | "node" | "other"` 的任意组合
- `limit?: number` 最大行数（默认：服务器默认值，上限如 200）
- `activeMinutes?: number` 仅返回 N 分钟内更新的会话
- `messageLimit?: number` 0 = 不返回消息（默认 0）；>0 = 包含最近 N 条消息

行为：

- `messageLimit > 0` 时会获取每个会话的 `chat.history` 并包含最近 N 条消息。
- 列表输出中会过滤工具结果；使用 `sessions_history` 获取工具消息。
- 在**沙箱隔离**的智能体会话中运行时，会话工具默认为**仅已生成可见**（见下文）。

行结构（JSON）：

- `key`：会话键（字符串）
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（群组显示标签，如可用）
- `updatedAt`（毫秒）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（会话覆盖，如已设置）
- `lastChannel`、`lastTo`
- `deliveryContext`（规范化的 `{ channel, to, accountId }`，如可用）
- `transcriptPath`（根据存储目录 + sessionId 推导的尽力路径）
- `messages?`（仅当 `messageLimit > 0` 时）

## sessions_history

获取单个会话的对话记录。

参数：

- `sessionKey`（必需；接受会话键或来自 `sessions_list` 的 `sessionId`）
- `limit?: number` 最大消息数（服务器限制上限）
- `includeTools?: boolean`（默认 false）

行为：

- `includeTools=false` 过滤 `role: "toolResult"` 的消息。
- 以原始对话记录格式返回消息数组。
- 当传入 `sessionId` 时，OpenClaw 会将其解析为对应的会话键（缺失的 ID 会报错）。

## sessions_send

向另一个会话发送消息。

参数：

- `sessionKey`（必需；接受会话键或来自 `sessions_list` 的 `sessionId`）
- `message`（必需）
- `timeoutSeconds?: number`（默认 >0；0 = 即发即忘）

行为：

- `timeoutSeconds = 0`：入队并返回 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：等待最多 N 秒完成，然后返回 `{ runId, status: "ok", reply }`。
- 如果等待超时：`{ runId, status: "timeout", error }`。运行继续；稍后调用 `sessions_history`。
- 如果运行失败：`{ runId, status: "error", error }`。
- 通知投递在主运行完成后运行，属于尽力而为；`status: "ok"` 不保证通知已成功投递。
- 通过 Gateway网关 `agent.wait`（服务器端）等待，因此重连不会中断等待。
- 智能体间消息上下文会注入到主运行中。
- 主运行完成后，OpenClaw 运行**回复往返循环**：
  - 第 2 轮及之后在请求方和目标智能体之间交替。
  - 回复 `REPLY_SKIP` 可停止来回往返。
  - 最大轮数为 `session.agentToAgent.maxPingPongTurns`（0–5，默认 5）。
- 循环结束后，OpenClaw 运行**智能体间通知步骤**（仅目标智能体）：
  - 回复 `ANNOUNCE_SKIP` 可保持静默。
  - 其他任何回复都会发送到目标渠道。
  - 通知步骤包含原始请求 + 第 1 轮回复 + 最新的往返回复。

## Channel 字段

- 对于群组，`channel` 是会话条目上记录的渠道。
- 对于私聊，`channel` 从 `lastChannel` 映射。
- 对于定时任务/钩子/节点，`channel` 为 `internal`。
- 如果缺失，`channel` 为 `unknown`。

## 安全 / 发送策略

基于策略的按渠道/聊天类型阻止（非按会话 ID）。

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

- `chat.send` / `agent`（Gateway网关）
- 自动回复投递逻辑

## sessions_spawn

在隔离会话中生成子智能体运行，并将结果通知回请求方的聊天渠道。

参数：

- `task`（必需）
- `label?`（可选；用于日志/UI）
- `agentId?`（可选；如允许，在另一个智能体 ID 下生成）
- `model?`（可选；覆盖子智能体模型；无效值会报错）
- `runTimeoutSeconds?`（默认 0；设置后，N 秒后中止子智能体运行）
- `cleanup?`（`delete|keep`，默认 `keep`）

允许列表：

- `agents.list[].subagents.allowAgents`：允许通过 `agentId` 使用的智能体 ID 列表（`["*"]` 允许任意）。默认：仅请求方智能体。

发现：

- 使用 `agents_list` 发现哪些智能体 ID 可用于 `sessions_spawn`。

行为：

- 启动一个新的 `agent:<agentId>:subagent:<uuid>` 会话，设置 `deliver: false`。
- 子智能体默认使用完整工具集**减去会话工具**（可通过 `tools.subagents.tools` 配置）。
- 子智能体不允许调用 `sessions_spawn`（不允许子智能体生成子智能体）。
- 始终非阻塞：立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 完成后，OpenClaw 运行子智能体**通知步骤**并将结果发布到请求方的聊天渠道。
- 在通知步骤中回复 `ANNOUNCE_SKIP` 可保持静默。
- 通知回复规范化为 `Status`/`Result`/`Notes`；`Status` 来自运行时结果（非模型文本）。
- 子智能体会话在 `agents.defaults.subagents.archiveAfterMinutes`（默认：60）后自动归档。
- 通知回复包含统计行（运行时间、token 数、sessionKey/sessionId、对话记录路径和可选费用）。

## 沙箱会话可见性

沙箱隔离的会话可以使用会话工具，但默认只能看到通过 `sessions_spawn` 生成的会话。

配置：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // 默认: "spawned"
        sessionToolsVisibility: "spawned", // 或 "all"
      },
    },
  },
}
```
