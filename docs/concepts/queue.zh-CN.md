---
summary: "序列化入站自动回复运行的命令队列设计"
read_when:
  - 更改自动回复执行或并发
  - 理解消息处理队列的工作原理
title: "命令队列"
---

# 命令队列 (2026-01-16)

我们通过一个微小的进程内队列序列化入站自动回复运行（所有频道），以防止多个代理运行冲突，同时仍然允许跨会话的安全并行。

## 为什么

- 自动回复运行可能很昂贵（LLM 调用），当多个入站消息紧密到达时可能会冲突。
- 序列化避免了竞争共享资源（会话文件、日志、CLI stdin）并减少了上游速率限制的机会。

## 工作原理

- 一个支持通道的 FIFO 队列使用可配置的并发上限排出每个通道（未配置通道默认为 1；主通道默认为 4，子代理为 8）。
- `runEmbeddedPiAgent` 按**会话键**（通道 `session:<key>`）入队，以保证每个会话只有一个活动运行。
- 每个会话运行然后被入队到**全局通道**（默认 `main`），因此总体并行度由 `agents.defaults.maxConcurrent` 限制。
- 当启用详细日志记录时，如果排队的运行在开始前等待了超过约 2 秒，它们会发出简短通知。
- 打字指示器仍然在入队时立即触发（当频道支持时），因此用户体验在我们等待轮到时保持不变。

## 队列模式（每个频道）

入站消息可以引导当前运行、等待后续回合，或两者都做：

- `steer`：立即注入到当前运行中（在下一个工具边界后取消挂起的工具调用）。如果不流式传输，回退到后续。
- `followup`：在当前运行结束后入队到下一个代理回合。
- `collect`：将所有排队的消息合并到**单个**后续回合中（默认）。如果消息针对不同的频道/线程，它们会单独排出以保留路由。
- `steer-backlog`（又名 `steer+backlog`）：现在引导**并**保留消息用于后续回合。
- `interrupt`（旧版）：中止该会话的活动运行，然后运行最新的消息。
- `queue`（旧版别名）：与 `steer` 相同。

Steer-backlog 意味着您可以在引导运行后获得后续响应，因此流式传输表面可能看起来像重复。如果您希望每个入站消息有一个响应，请首选 `collect`/`steer`。
发送 `/queue collect` 作为独立命令（每个会话）或设置 `messages.queue.byChannel.discord: "collect"`。

默认值（在配置中未设置时）：

- 所有表面 → `collect`

通过 `messages.queue` 全局或按频道配置：

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## 队列选项

选项适用于 `followup`、`collect` 和 `steer-backlog`（以及回退到后续的 `steer`）：

- `debounceMs`：在开始后续回合之前等待安静（防止“继续，继续”）。
- `cap`：每个会话的最大排队消息数。
- `drop`：溢出策略（`old`、`new`、`summarize`）。

Summarize 保留被丢弃消息的简短项目符号列表，并将其作为合成后续提示注入。
默认值：`debounceMs: 1000`，`cap: 20`，`drop: summarize`。

## 每个会话覆盖

- 发送 `/queue <mode>` 作为独立命令，为当前会话存储模式。
- 选项可以组合：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 清除会话覆盖。

## 范围和保证

- 适用于跨所有使用网关回复管道的入站频道的自动回复代理运行（WhatsApp web、Telegram、Slack、Discord、Signal、iMessage、webchat 等）。
- 默认通道（`main`）对于入站 + 主心跳是进程范围的；设置 `agents.defaults.maxConcurrent` 以允许并行多个会话。
- 可能存在其他通道（例如 `cron`、`subagent`），因此后台作业可以并行运行而不阻塞入站回复。这些分离的运行被跟踪为 [后台任务](/automation/tasks)。
- 每个会话通道保证同一时间只有一个代理运行触摸给定会话。
- 无外部依赖或后台工作线程；纯 TypeScript + 承诺。

## 故障排除

- 如果命令似乎卡住，启用详细日志并查找“queued for …ms”行以确认队列正在排出。
- 如果您需要队列深度，启用详细日志并观察队列计时行。