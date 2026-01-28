---
read_when:
  - 你希望通过智能体进行后台/并行工作
  - 你正在修改 sessions_spawn 或子智能体工具策略
summary: 子智能体：生成独立的智能体运行并将结果回报给请求者聊天
title: 子智能体
x-i18n:
  generated_at: "2026-02-01T21:43:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0e88b4a52d2f0df3dc7c7de87af7ab86f73b81aed91c01e676aa0bd2512d7d21
  source_path: tools/subagents.md
  workflow: 15
---

# 子智能体

子智能体是从现有智能体运行中生成的后台智能体运行。它们在自己的会话（`agent:<agentId>:subagent:<uuid>`）中运行，完成后会将结果**回报**到请求者的聊天渠道。

## 斜杠命令

使用 `/subagents` 检查或控制**当前会话**的子智能体运行：

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` 显示运行元数据（状态、时间戳、会话 ID、转录路径、清理方式）。

主要目标：

- 并行化"研究/长任务/慢工具"工作，不阻塞主运行。
- 默认保持子智能体隔离（会话分离 + 可选沙箱）。
- 保持工具表面难以被滥用：子智能体默认**不**获取会话工具。
- 避免嵌套扇出：子智能体不能生成子智能体。

费用提示：每个子智能体有其**独立的**上下文和 token 用量。对于繁重或重复的任务，建议为子智能体设置较便宜的模型，主智能体保持使用更高质量的模型。可通过 `agents.defaults.subagents.model` 或按智能体覆盖进行配置。

## 工具

使用 `sessions_spawn`：

- 启动子智能体运行（`deliver: false`，全局队列：`subagent`）
- 然后运行回报步骤，将回报回复发布到请求者的聊天渠道
- 默认模型：继承调用者，除非你设置了 `agents.defaults.subagents.model`（或按智能体 `agents.list[].subagents.model`）；显式的 `sessions_spawn.model` 仍然优先。
- 默认思考级别：继承调用者，除非你设置了 `agents.defaults.subagents.thinking`（或按智能体 `agents.list[].subagents.thinking`）；显式的 `sessions_spawn.thinking` 仍然优先。

工具参数：

- `task`（必填）
- `label?`（可选）
- `agentId?`（可选；如果允许，在另一个智能体 ID 下生成）
- `model?`（可选；覆盖子智能体模型；无效值会被跳过，子智能体将使用默认模型运行并在工具结果中发出警告）
- `thinking?`（可选；覆盖子智能体运行的思考级别）
- `runTimeoutSeconds?`（默认 `0`；设置后，子智能体运行在 N 秒后中止）
- `cleanup?`（`delete|keep`，默认 `keep`）

允许列表：

- `agents.list[].subagents.allowAgents`：可通过 `agentId` 指定的智能体 ID 列表（`["*"]` 允许任意）。默认：仅请求者智能体。

发现：

- 使用 `agents_list` 查看当前允许用于 `sessions_spawn` 的智能体 ID。

自动归档：

- 子智能体会话在 `agents.defaults.subagents.archiveAfterMinutes`（默认：60）后自动归档。
- 归档使用 `sessions.delete` 并将转录重命名为 `*.deleted.<timestamp>`（同一文件夹）。
- `cleanup: "delete"` 在回报后立即归档（仍通过重命名保留转录）。
- 自动归档为尽力而为；如果 Gateway网关重启，待处理的定时器会丢失。
- `runTimeoutSeconds` **不会**自动归档；它仅停止运行。会话保留直到自动归档。

## 认证

子智能体认证按**智能体 ID** 解析，而非按会话类型：

- 子智能体会话键为 `agent:<agentId>:subagent:<uuid>`。
- 认证存储从该智能体的 `agentDir` 加载。
- 主智能体的认证配置文件作为**回退**合并；冲突时智能体配置文件覆盖主配置文件。

注意：合并是叠加的，因此主配置文件始终作为回退可用。目前尚不支持按智能体完全隔离的认证。

## 回报

子智能体通过回报步骤汇报结果：

- 回报步骤在子智能体会话内运行（而非请求者会话）。
- 如果子智能体回复的内容恰好为 `ANNOUNCE_SKIP`，则不发布任何内容。
- 否则，回报回复通过后续的 `agent` 调用（`deliver=true`）发布到请求者的聊天渠道。
- 回报回复在可用时保留线程/话题路由（Slack 线程、Telegram 话题、Matrix 线程）。
- 回报消息被规范化为稳定的模板：
  - `Status:`：根据运行结果推导（`success`、`error`、`timeout` 或 `unknown`）。
  - `Result:`：回报步骤的摘要内容（如缺失则为 `(not available)`）。
  - `Notes:`：错误详情和其他有用的上下文。
- `Status` 不从模型输出推断；它来自运行时结果信号。

回报负载末尾包含统计行（即使被包装时也是如此）：

- 运行时间（例如 `runtime 5m12s`）
- Token 用量（输入/输出/总计）
- 配置了模型定价时的预估费用（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId` 和转录路径（以便主智能体可通过 `sessions_history` 获取历史记录或检查磁盘上的文件）

## 工具策略（子智能体工具）

默认情况下，子智能体获取**除会话工具外的所有工具**：

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

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
        // 如果设置了 allow，则变为仅允许模式（deny 仍然优先）
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 并发

子智能体使用专用的进程内队列通道：

- 通道名称：`subagent`
- 并发数：`agents.defaults.subagents.maxConcurrent`（默认 `8`）

## 停止

- 在请求者聊天中发送 `/stop` 会中止请求者会话并停止从中生成的所有活跃子智能体运行。

## 限制

- 子智能体回报为**尽力而为**。如果 Gateway网关重启，待处理的"回报"工作会丢失。
- 子智能体仍共享相同的 Gateway网关进程资源；将 `maxConcurrent` 视为安全阀。
- `sessions_spawn` 始终是非阻塞的：它会立即返回 `{ status: "accepted", runId, childSessionKey }`。
- 子智能体上下文仅注入 `AGENTS.md` + `TOOLS.md`（不包含 `SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md` 或 `BOOTSTRAP.md`）。
