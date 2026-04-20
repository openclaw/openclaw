---
summary: "子代理：生成独立的代理运行，将结果通知回请求者聊天"
read_when:
  - 您希望通过代理进行后台/并行工作
  - 您正在更改 sessions_spawn 或子代理工具策略
  - 您正在实现或排查线程绑定的子代理会话
title: "子代理"
---

# 子代理

子代理是从现有代理运行中生成的后台代理运行。它们在自己的会话中运行（`agent:<agentId>:subagent:<uuid>`），完成后会**通知**结果回请求者聊天通道。每个子代理运行都被跟踪为一个[后台任务](/automation/tasks)。

## 斜杠命令

使用 `/subagents` 来检查或控制**当前会话**的子代理运行：

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

线程绑定控制：

这些命令在支持持久线程绑定的通道上工作。请参阅下面的**支持线程的通道**。

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session idle <duration|off>`
- `/session max-age <duration|off>`

`/subagents info` 显示运行元数据（状态、时间戳、会话 ID、转录路径、清理）。
使用 `sessions_history` 获取有界、安全过滤的回忆视图；当您需要原始完整转录时，检查磁盘上的转录路径。

### 生成行为

`/subagents spawn` 以用户命令而不是内部中继的形式启动后台子代理，并在运行完成时向请求者聊天发送一个最终完成更新。

- 生成命令是非阻塞的；它立即返回一个运行 ID。
- 完成后，子代理向请求者聊天通道宣布一个摘要/结果消息。
- 完成是基于推送的。生成后，不要在循环中轮询 `/subagents list`、`sessions_list` 或 `sessions_history` 只是为了等待它完成；仅在需要调试或干预时按需检查状态。
- 完成时，OpenClaw 会尽力关闭该子代理会话打开的跟踪浏览器标签页/进程，然后继续通知清理流程。
- 对于手动生成，传递是弹性的：
  - OpenClaw 首先尝试使用稳定的幂等键进行直接 `agent` 传递。
  - 如果直接传递失败，它会回退到队列路由。
  - 如果队列路由仍然不可用，通知会在最终放弃之前使用短指数退避重试。
- 完成传递保留已解析的请求者路由：
  - 线程绑定或会话绑定的完成路由在可用时优先
  - 如果完成源只提供通道，OpenClaw 会从请求者会话的已解析路由（`lastChannel` / `lastTo` / `lastAccountId`）中填充缺失的目标/账户，以便直接传递仍然有效
- 传递给请求者会话的完成交接是运行时生成的内部上下文（不是用户编写的文本），包括：
  - `Result`（最新可见的 `assistant` 回复文本，否则是经过清理的最新工具/工具结果文本）
  - `Status`（`completed successfully` / `failed` / `timed out` / `unknown`）
  - 紧凑的运行时/令牌统计
  - 一个传递指令，告诉请求者代理以正常的助手声音重写（不转发原始内部元数据）
- `--model` 和 `--thinking` 覆盖该特定运行的默认值。
- 使用 `info`/`log` 在完成后检查详细信息和输出。
- `/subagents spawn` 是一次性模式（`mode: "run"`）。对于持久的线程绑定会话，使用带有 `thread: true` 和 `mode: "session"` 的 `sessions_spawn`。
- 对于 ACP 测试会话（Codex、Claude Code、Gemini CLI），使用带有 `runtime: "acp"` 的 `sessions_spawn` 并参阅 [ACP 代理](/tools/acp-agents)。

主要目标：

- 并行化 "研究/长任务/慢速工具" 工作，而不阻塞主运行。
- 默认保持子代理隔离（会话分离 + 可选沙箱）。
- 保持工具表面难以误用：子代理默认**不**获得会话工具。
- 支持协调器模式的可配置嵌套深度。

成本说明：每个子代理都有自己的**独立**上下文和令牌使用。对于繁重或重复的任务，为子代理设置更便宜的模型，并在更高质量的模型上保持主代理。您可以通过 `agents.defaults.subagents.model` 或每个代理的覆盖来配置这一点。

## 工具

使用 `sessions_spawn`：

- 启动子代理运行（`deliver: false`，全局通道：`subagent`）
- 然后运行通知步骤并将通知回复发布到请求者聊天通道
- 默认模型：继承调用者，除非您设置 `agents.defaults.subagents.model`（或每个代理的 `agents.list[].subagents.model`）；显式的 `sessions_spawn.model` 仍然优先。
- 默认思考：继承调用者，除非您设置 `agents.defaults.subagents.thinking`（或每个代理的 `agents.list[].subagents.thinking`）；显式的 `sessions_spawn.thinking` 仍然优先。
- 默认运行超时：如果省略 `sessions_spawn.runTimeoutSeconds`，OpenClaw 会使用 `agents.defaults.subagents.runTimeoutSeconds`（如果设置）；否则回退到 `0`（无超时）。

工具参数：

- `task`（必填）
- `label?`（可选）
- `agentId?`（可选；如果允许，在另一个代理 ID 下生成）
- `model?`（可选；覆盖子代理模型；无效值会被跳过，子代理会在默认模型上运行并在工具结果中显示警告）
- `thinking?`（可选；覆盖子代理运行的思考级别）
- `runTimeoutSeconds?`（默认为 `agents.defaults.subagents.runTimeoutSeconds`（如果设置），否则为 `0`；设置后，子代理运行会在 N 秒后中止）
- `thread?`（默认 `false`；当 `true` 时，为此子代理会话请求通道线程绑定）
- `mode?`（`run|session`）
  - 默认是 `run`
  - 如果 `thread: true` 且省略 `mode`，默认变为 `session`
  - `mode: "session"` 需要 `thread: true`
- `cleanup?`（`delete|keep`，默认 `keep`）
- `sandbox?`（`inherit|require`，默认 `inherit`；`require` 拒绝生成，除非目标子运行时被沙箱化）
- `sessions_spawn` **不**接受通道传递参数（`target`、`channel`、`to`、`threadId`、`replyTo`、`transport`）。对于传递，使用生成运行中的 `message`/`sessions_send`。

## 线程绑定会话

当通道启用线程绑定时，子代理可以保持绑定到线程，以便该线程中的后续用户消息继续路由到同一个子代理会话。

### 支持线程的通道

- Discord（目前唯一支持的通道）：支持持久的线程绑定子代理会话（带有 `thread: true` 的 `sessions_spawn`）、手动线程控制（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`）以及适配器键 `channels.discord.threadBindings.enabled`、`channels.discord.threadBindings.idleHours`、`channels.discord.threadBindings.maxAgeHours` 和 `channels.discord.threadBindings.spawnSubagentSessions`。

快速流程：

1. 使用 `sessions_spawn` 生成，使用 `thread: true`（可选 `mode: "session"`）。
2. OpenClaw 在活动通道中为该会话目标创建或绑定一个线程。
3. 该线程中的回复和后续消息路由到绑定的会话。
4. 使用 `/session idle` 检查/更新不活动自动取消聚焦，使用 `/session max-age` 控制硬上限。
5. 使用 `/unfocus` 手动分离。

手动控制：

- `/focus <target>` 将当前线程（或创建一个）绑定到子代理/会话目标。
- `/unfocus` 移除当前绑定线程的绑定。
- `/agents` 列出活动运行和绑定状态（`thread:<id>` 或 `unbound`）。
- `/session idle` 和 `/session max-age` 仅适用于聚焦的绑定线程。

配置开关：

- 全局默认：`session.threadBindings.enabled`、`session.threadBindings.idleHours`、`session.threadBindings.maxAgeHours`
- 通道覆盖和生成自动绑定键是适配器特定的。请参阅上面的**支持线程的通道**。

请参阅 [配置参考](/gateway/configuration-reference) 和 [斜杠命令](/tools/slash-commands) 了解当前适配器详情。

允许列表：

- `agents.list[].subagents.allowAgents`：可以通过 `agentId` 定位的代理 ID 列表（`["*"]` 允许任何）。默认：仅请求者代理。
- `agents.defaults.subagents.allowAgents`：当请求者代理未设置自己的 `subagents.allowAgents` 时使用的默认目标代理允许列表。
- 沙箱继承保护：如果请求者会话被沙箱化，`sessions_spawn` 会拒绝将运行非沙箱化的目标。
- `agents.defaults.subagents.requireAgentId` / `agents.list[].subagents.requireAgentId`：当为 true 时，阻止省略 `agentId` 的 `sessions_spawn` 调用（强制显式配置文件选择）。默认：false。

发现：

- 使用 `agents_list` 查看当前允许用于 `sessions_spawn` 的代理 ID。

自动存档：

- 子代理会话在 `agents.defaults.subagents.archiveAfterMinutes`（默认：60）后自动存档。
- 存档使用 `sessions.delete` 并将转录重命名为 `*.deleted.<timestamp>`（同一文件夹）。
- `cleanup: "delete"` 在通知后立即存档（仍然通过重命名保留转录）。
- 自动存档是尽力而为的；如果网关重启，挂起的计时器会丢失。
- `runTimeoutSeconds` **不**自动存档；它只停止运行。会话会一直保留到自动存档。
- 自动存档同样适用于深度为 1 和深度为 2 的会话。
- 浏览器清理与存档清理是分开的：当运行完成时，即使保留转录/会话记录，也会尽力关闭跟踪的浏览器标签页/进程。

## 嵌套子代理

默认情况下，子代理不能生成自己的子代理（`maxSpawnDepth: 1`）。您可以通过设置 `maxSpawnDepth: 2` 来启用一级嵌套，这允许**协调器模式**：主 → 协调器子代理 → 工作子子代理。

### 如何启用

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // 允许子代理生成子代理（默认：1）
        maxChildrenPerAgent: 5, // 每个代理会话的最大活动子代理数（默认：5）
        maxConcurrent: 8, // 全局并发通道上限（默认：8）
        runTimeoutSeconds: 900, // 省略时 sessions_spawn 的默认超时（0 = 无超时）
      },
    },
  },
}
```

### 深度级别

| 深度 | 会话键形状                                   | 角色                              | 可以生成？                |
| ---- | -------------------------------------------- | --------------------------------- | ------------------------- |
| 0    | `agent:<id>:main`                            | 主代理                            | 始终                      |
| 1    | `agent:<id>:subagent:<uuid>`                 | 子代理（当深度 2 允许时为协调器） | 仅当 `maxSpawnDepth >= 2` |
| 2    | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | 子子代理（叶工作者）              | 从不                      |

### 通知链

结果沿链向上流动：

1. 深度 2 工作者完成 → 向其父级（深度 1 协调器）通知
2. 深度 1 协调器接收通知，综合结果，完成 → 向主代理通知
3. 主代理接收通知并传递给用户

每个级别只看到其直接子级的通知。

操作指南：

- 开始子工作一次并等待完成事件，而不是围绕 `sessions_list`、`sessions_history`、`/subagents list` 或 `exec` 睡眠命令构建轮询循环。
- 如果子完成事件在您已经发送最终答案后到达，正确的后续操作是确切的静默令牌 `NO_REPLY` / `no_reply`。

### 按深度的工具策略

- 角色和控制范围在生成时写入会话元数据。这可以防止扁平或恢复的会话键意外重新获得协调器权限。
- **深度 1（协调器，当 `maxSpawnDepth >= 2` 时）**：获得 `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history`，以便它可以管理其子级。其他会话/系统工具仍然被拒绝。
- **深度 1（叶节点，当 `maxSpawnDepth == 1` 时）**：没有会话工具（当前默认行为）。
- **深度 2（叶工作者）**：没有会话工具 — `sessions_spawn` 在深度 2 时始终被拒绝。不能生成进一步的子代理。

### 每个代理的生成限制

每个代理会话（任何深度）一次最多可以有 `maxChildrenPerAgent`（默认：5）个活动子代理。这可以防止单个协调器的失控扇出。

### 级联停止

停止深度 1 协调器会自动停止其所有深度 2 子代理：

- 在主聊天中发送 `/stop` 会停止所有深度 1 代理并级联到它们的深度 2 子代理。
- `/subagents kill <id>` 停止特定的子代理并级联到其子级。
- `/subagents kill all` 停止请求者的所有子代理并级联。

## 认证

子代理认证通过**代理 ID** 解决，而不是会话类型：

- 子代理会话键为 `agent:<agentId>:subagent:<uuid>`。
- 认证存储从该代理的 `agentDir` 加载。
- 主代理的认证配置文件作为**回退**合并；代理配置文件在冲突时覆盖主配置文件。

注意：合并是 additive 的，因此主配置文件始终可用作回退。每个代理的完全隔离认证尚未支持。

## 通知

子代理通过通知步骤报告：

- 通知步骤在子代理会话（不是请求者会话）内运行。
- 如果子代理的回复恰好是 `ANNOUNCE_SKIP`，则不发布任何内容。
- 如果最新的助手文本是确切的静默令牌 `NO_REPLY` / `no_reply`，即使存在早期可见的进度，通知输出也会被抑制。
- 否则，传递取决于请求者深度：
  - 顶级请求者会话使用带有外部传递的后续 `agent` 调用（`deliver=true`）
  - 嵌套的请求者子代理会话接收内部后续注入（`deliver=false`），以便协调器可以在会话中综合子结果
  - 如果嵌套的请求者子代理会话已消失，OpenClaw 会在可用时回退到该会话的请求者
- 对于顶级请求者会话，完成模式的直接传递首先解析任何绑定的会话/线程路由和钩子覆盖，然后从请求者会话的存储路由填充缺失的通道目标字段。这使得即使完成源只识别通道，完成也能在正确的聊天/主题上进行。
- 子完成聚合在构建嵌套完成结果时限定于当前请求者运行，防止过时的先前运行子输出泄漏到当前通知中。
- 通知回复在通道适配器上可用时保留线程/主题路由。
- 通知上下文被标准化为稳定的内部事件块：
  - 源（`subagent` 或 `cron`）
  - 子会话键/ID
  - 通知类型 + 任务标签
  - 从运行时结果派生的状态行（`success`、`error`、`timeout` 或 `unknown`）
  - 从最新可见的助手文本中选择的结果内容，否则是经过清理的最新工具/工具结果文本
  - 描述何时回复与保持静默的后续指令
- `Status` 不是从模型输出推断的；它来自运行时结果信号。
- 超时后，如果子代理只完成了工具调用，通知可以将该历史记录折叠为简短的部分进度摘要，而不是重放原始工具输出。

通知有效载荷在末尾包含一行统计信息（即使被包装）：

- 运行时（例如，`runtime 5m12s`）
- 令牌使用情况（输入/输出/总计）
- 配置模型定价时的估计成本（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId` 和转录路径（以便主代理可以通过 `sessions_history` 获取历史记录或在磁盘上检查文件）
- 内部元数据仅用于编排；面向用户的回复应以正常的助手声音重写。

`sessions_history` 是更安全的编排路径：

- 助手回忆首先被标准化：
  - 思考标签被剥离
  - `<relevant-memories>` / `<relevant_memories>` 脚手架块被剥离
  - 纯文本工具调用 XML 有效载荷块，如 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>` 和 `<function_calls>...</function_calls>` 被剥离，包括从未干净关闭的截断有效载荷
  - 降级的工具调用/结果脚手架和历史上下文标记被剥离
  - 泄漏的模型控制令牌，如 `<|assistant|>`、其他 ASCII `<|...|>` 令牌和全宽 `<｜...｜>` 变体被剥离
  - 格式错误的 MiniMax 工具调用 XML 被剥离
- 凭证/令牌类文本被编辑
- 长块可以被截断
- 非常大的历史记录可以删除较旧的行或用 `[sessions_history omitted: message too large]` 替换过大的行
- 当您需要完整的字节级转录时，原始磁盘转录检查是回退方案

## 工具策略（子代理工具）

默认情况下，子代理获得**除会话工具和系统工具外的所有工具**：

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

`sessions_history` 在这里也仍然是一个有界、经过清理的回忆视图；它不是原始转录转储。

当 `maxSpawnDepth >= 2` 时，深度 1 协调器子代理另外接收 `sessions_spawn`、`subagents`、`sessions_list` 和 `sessions_history`，以便它们可以管理其子级。

通过配置覆盖：

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny 优先
        deny: ["gateway", "cron"],
        // 如果设置了 allow，它将变为仅允许（deny 仍然优先）
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 并发

子代理使用专用的进程内队列通道：

- 通道名称：`subagent`
- 并发：`agents.defaults.subagents.maxConcurrent`（默认 `8`）

## 停止

- 在请求者聊天中发送 `/stop` 会中止请求者会话并停止从它生成的任何活动子代理运行，级联到嵌套子代理。
- `/subagents kill <id>` 停止特定的子代理并级联到其子级。

## 限制

- 子代理通知是**尽力而为**的。如果网关重启，待处理的"通知回"工作会丢失。
- 子代理仍然共享相同的网关进程资源；将 `maxConcurrent` 视为安全阀。
- `sessions_spawn` 始终是非阻塞的：它立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 子代理上下文只注入 `AGENTS.md` + `TOOLS.md`（没有 `SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md` 或 `BOOTSTRAP.md`）。
- 最大嵌套深度为 5（`maxSpawnDepth` 范围：1–5）。深度 2 推荐用于大多数用例。
- `maxChildrenPerAgent` 限制每个会话的活动子代理数（默认：5，范围：1–20）。
