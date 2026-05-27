---
read_when:
  - 更改自动回复执行或并发设置时
summary: 用于序列化入站自动回复运行的命令队列设计
title: 命令队列
x-i18n:
  generated_at: "2026-02-03T10:05:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2104c24d200fb4f9620e52a19255cd614ababe19d78f3ee42936dc6d0499b73b
  source_path: concepts/queue.md
  workflow: 15
---

# 命令队列（2026-01-16）

我们通过一个小型进程内队列序列化入站自动回复运行（所有渠道），以防止多个智能体运行发生冲突，同时仍允许跨会话的安全并行。

## 为什么需要

- 自动回复运行可能开销很大（LLM 调用），当多条入站消息接近同时到达时可能发生冲突。
- 序列化可以避免竞争共享资源（会话文件、日志、CLI stdin），并降低上游速率限制的可能性。

## 工作原理

- 一个支持通道感知的 FIFO 队列以可配置的并发上限排空每个通道（未配置的通道默认为 1；main 默认为 4，subagent 为 8）。
- `runEmbeddedPiAgent` 按**会话键**入队（通道 `session:<key>`），以保证每个会话只有一个活动运行。
- 然后每个会话运行被排入**全局通道**（默认为 `main`），因此整体并行度受 `agents.defaults.maxConcurrent` 限制。
- 启用详细日志时，如果排队运行在开始前等待超过约 2 秒，会发出简短通知。
- 输入指示器仍在入队时立即触发（当渠道支持时），因此在等待轮次时用户体验不受影响。

## 队列模式（按渠道）

入站消息可以引导当前运行、等待后续轮次，或两者兼顾：

- `steer`：立即注入当前运行（在下一个工具边界后取消待处理的工具调用）。如果未在流式传输，则回退到 followup。
- `followup`：在当前运行结束后为下一个智能体轮次入队。
- `collect`：将所有排队消息合并为**单个**后续轮次（默认）。如果消息针对不同的渠道/线程，它们会单独排空以保留路由。
- `steer-backlog`（又名 `steer+backlog`）：现在引导**并**保留消息用于后续轮次。
- `interrupt`（旧版）：中止该会话的活动运行，然后运行最新消息。
- `queue`（旧版别名）：与 `steer` 相同。

steer-backlog 意味着你可以在被引导的运行之后获得后续响应，因此流式传输界面可能看起来像重复。如果你希望每条入站消息只有一个响应，请优先使用 `collect`/`steer`。
发送 `/queue collect` 作为独立命令（按会话）或设置 `messages.queue.byChannel.discord: "collect"`。

默认值（配置中未设置时）：

- 所有界面 → `collect`

通过 `messages.queue` 全局或按渠道配置：

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

选项适用于 `followup`、`collect` 和 `steer-backlog`（以及当 `steer` 回退到 followup 时）：

- `debounceMs`：在开始后续轮次前等待静默（防止"继续，继续"）。
- `cap`：每个会话的最大排队消息数。
- `drop`：溢出策略（`old`、`new`、`summarize`）。

summarize 保留被丢弃消息的简短要点列表，并将其作为合成的后续提示注入。
默认值：`debounceMs: 1000`、`cap: 20`、`drop: summarize`。

## 按会话覆盖

- 发送 `/queue <mode>` 作为独立命令，为当前会话存储该模式。
- 选项可以组合：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 清除会话覆盖。

## 范围和保证

- 适用于所有使用 Gateway 网关回复管道的入站渠道的自动回复智能体运行（WhatsApp 网页版、Telegram、Slack、Discord、Signal、iMessage、网页聊天等）。
- 默认通道（`main`）对入站 + 主心跳是进程范围的；设置 `agents.defaults.maxConcurrent` 以允许多个会话并行。
- 可能存在额外的通道（例如 `cron`、`subagent`），以便后台任务可以并行运行而不阻塞入站回复。
- 按会话通道保证一次只有一个智能体运行触及给定会话。
- 无外部依赖或后台工作线程；纯 TypeScript + promises。

## 故障排除

- 如果命令似乎卡住，启用详细日志并查找"queued for …ms"行以确认队列正在排空。
- 如果你需要查看队列深度，启用详细日志并观察队列计时行。
