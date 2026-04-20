---
summary: "用于跨会话状态、回忆、消息传递和子代理编排的代理工具"
read_when:
  - 您想了解代理拥有哪些会话工具
  - 您想配置跨会话访问或子代理生成
  - 您想检查状态或控制生成的子代理
title: "会话工具"
---

# 会话工具

OpenClaw 为代理提供工具，以跨会话工作、检查状态和编排子代理。

## 可用工具

| 工具 | 功能 |
| -------- | -------- |
| `sessions_list` | 列出会话，可选择过滤（类型、新近度） |
| `sessions_history` | 读取特定会话的记录 |
| `sessions_send` | 向另一个会话发送消息并可选地等待 |
| `sessions_spawn` | 为后台工作生成隔离的子代理会话 |
| `sessions_yield` | 结束当前回合并等待后续子代理结果 |
| `subagents` | 列出、引导或终止为此会话生成的子代理 |
| `session_status` | 显示 `/status` 风格的卡片并可选地设置每会话模型覆盖 |

## 列出和读取会话

`sessions_list` 返回会话及其键、类型、频道、模型、令牌计数和时间戳。按类型（`main`、`group`、`cron`、`hook`、`node`）或新近度（`activeMinutes`）过滤。

`sessions_history` 获取特定会话的对话记录。默认情况下，工具结果被排除 -- 传递 `includeTools: true` 以查看它们。返回的视图故意有界且经过安全过滤：

- 助手文本在回忆前被规范化：
  - 思考标签被剥离
  - `<relevant-memories>` / `<relevant_memories>` 脚手架块被剥离
  - 纯文本工具调用 XML 有效负载块，如 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>` 和 `<function_calls>...</function_calls>` 被剥离，包括从未干净关闭的截断有效负载
  - 降级的工具调用/结果脚手架，如 `[Tool Call: ...]`、`[Tool Result ...]` 和 `[Historical context ...]` 被剥离
  - 泄露的模型控制令牌，如 `<|assistant|>`、其他 ASCII `<|...|>` 令牌和全宽 `<｜...｜>` 变体被剥离
  - 格式错误的 MiniMax 工具调用 XML，如 `<invoke ...>` / `</minimax:tool_call>` 被剥离
- 凭证/令牌样文本在返回前被编辑
- 长文本块被截断
- 非常大的历史记录可能会删除较旧的行或用 `[sessions_history omitted: message too large]` 替换过大的行
- 该工具报告摘要标志，如 `truncated`、`droppedMessages`、`contentTruncated`、`contentRedacted` 和 `bytes`

两个工具都接受**会话键**（如 `"main"`）或来自先前列表调用的**会话 ID**。

如果您需要确切的逐字节记录，请检查磁盘上的记录文件，而不是将 `sessions_history` 视为原始转储。

## 发送跨会话消息

`sessions_send` 向另一个会话传递消息并可选地等待响应：

- **即发即忘：** 设置 `timeoutSeconds: 0` 以入队并立即返回。
- **等待回复：** 设置超时并内联获取响应。

目标响应后，OpenClaw 可以运行**回复循环**，其中代理交替消息（最多 5 轮）。目标代理可以回复 `REPLY_SKIP` 以提前停止。

## 状态和编排助手

`session_status` 是当前或另一个可见会话的轻量级 `/status` 等效工具。它报告使用情况、时间、模型/运行时状态，以及存在时的链接后台任务上下文。与 `/status` 一样，它可以从最新的记录使用条目回填稀疏的令牌/缓存计数器，`model=default` 清除每会话覆盖。

`sessions_yield` 故意结束当前回合，以便下一条消息可以是您等待的后续事件。在生成子代理后使用它，当您希望完成结果作为下一条消息到达，而不是构建轮询循环。

`subagents` 是已经生成的 OpenClaw 子代理的控制平面助手。它支持：

- `action: "list"` 检查活动/最近运行
- `action: "steer"` 向运行中的子代理发送后续指导
- `action: "kill"` 停止一个子代理或 `all`

## 生成子代理

`sessions_spawn` 为后台任务创建隔离会话。它始终是非阻塞的 -- 立即返回 `runId` 和 `childSessionKey`。

关键选项：

- `runtime: "subagent"`（默认）或 `"acp"` 用于外部 harness 代理。
- 子会话的 `model` 和 `thinking` 覆盖。
- `thread: true` 将生成绑定到聊天线程（Discord、Slack 等）。
- `sandbox: "require"` 对子代理强制执行沙箱。

默认叶级子代理不获得会话工具。当 `maxSpawnDepth >= 2` 时，深度 1 编排器子代理另外接收 `sessions_spawn`、`subagents`、`sessions_list` 和 `sessions_history`，以便它们可以管理自己的子代理。叶级运行仍然不获得递归编排工具。

完成后，公告步骤将结果发布到请求者的频道。完成交付在可用时保留绑定的线程/主题路由，如果完成来源仅标识一个频道，OpenClaw 仍然可以重用请求者会话的存储路由（`lastChannel` / `lastTo`）进行直接交付。

有关 ACP 特定行为，请参阅 [ACP 代理](/tools/acp-agents)。

## 可见性

会话工具的范围被限定，以限制代理可以看到的内容：

| 级别 | 范围 |
| -------- | -------- |
| `self` | 仅当前会话 |
| `tree` | 当前会话 + 生成的子代理 |
| `agent` | 此代理的所有会话 |
| `all` | 所有会话（如果配置，跨代理） |

默认为 `tree`。沙盒会话无论配置如何都被限制为 `tree`。

## 进一步阅读

- [会话管理](/concepts/session) -- 路由、生命周期、维护
- [ACP 代理](/tools/acp-agents) -- 外部 harness 生成
- [多代理](/concepts/multi-agent) -- 多代理架构
- [网关配置](/gateway/configuration) -- 会话工具配置旋钮