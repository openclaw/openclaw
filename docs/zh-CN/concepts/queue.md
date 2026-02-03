---
read_when:
  - 更改自动回复执行或并发机制
summary: 序列化入站自动回复运行的命令队列设计
title: 命令队列
x-i18n:
  generated_at: "2026-02-01T20:23:48Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2104c24d200fb4f9620e52a19255cd614ababe19d78f3ee42936dc6d0499b73b
  source_path: concepts/queue.md
  workflow: 14
---

# 命令队列（2026-01-16）

我们通过一个轻量的进程内队列来序列化入站自动回复运行（所有渠道），以防止多个智能体运行发生冲突，同时仍允许跨会话的安全并行。

## 原因

- 自动回复运行可能开销很大（LLM 调用），当多条入站消息几乎同时到达时可能发生冲突。
- 序列化可以避免争用共享资源（会话文件、日志、CLI 标准输入），并降低触发上游速率限制的概率。

## 工作原理

- 一个支持通道感知的 FIFO 队列以可配置的并发上限逐通道排空（未配置的通道默认为 1；main 默认为 4，subagent 默认为 8）。
- `runEmbeddedPiAgent` 按**会话键**（通道 `session:<key>`）入队，以保证每个会话同一时间只有一个活跃运行。
- 每个会话运行随后被排入**全局通道**（默认为 `main`），因此整体并行度受 `agents.defaults.maxConcurrent` 限制。
- 启用详细日志时，如果排队的运行在启动前等待超过约 2 秒，会发出一条简短通知。
- 输入指示器在入队时仍会立即触发（当渠道支持时），因此在等待期间用户体验不受影响。

## 队列模式（按渠道）

入站消息可以引导当前运行、等待后续轮次，或两者兼顾：

- `steer`：立即注入当前运行（在下一个工具边界后取消待执行的工具调用）。如果未在流式传输，则回退为 followup。
- `followup`：在当前运行结束后排队等待下一个智能体轮次。
- `collect`：将所有排队消息合并为**单个**后续轮次（默认）。如果消息针对不同的渠道/线程，它们会单独排空以保留路由。
- `steer-backlog`（又名 `steer+backlog`）：立即引导**并且**保留消息用于后续轮次。
- `interrupt`（旧版）：中止该会话的活跃运行，然后运行最新消息。
- `queue`（旧版别名）：等同于 `steer`。

steer-backlog 意味着在引导运行之后你还能获得后续响应，因此流式传输界面可能看起来像重复内容。如果希望每条入站消息只获得一次响应，请优先使用 `collect`/`steer`。
发送 `/queue collect` 作为独立命令（按会话生效），或设置 `messages.queue.byChannel.discord: "collect"`。

默认值（配置中未设置时）：

- 所有界面 → `collect`

通过 `messages.queue` 进行全局或按渠道配置：

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

选项适用于 `followup`、`collect` 和 `steer-backlog`（以及 `steer` 回退为 followup 时）：

- `debounceMs`：在启动后续轮次前等待静默期（防止"继续，继续"的情况）。
- `cap`：每个会话的最大排队消息数。
- `drop`：溢出策略（`old`、`new`、`summarize`）。

summarize 会保留一个被丢弃消息的简短要点列表，并将其作为合成的后续提示词注入。
默认值：`debounceMs: 1000`、`cap: 20`、`drop: summarize`。

## 按会话覆盖

- 发送 `/queue <mode>` 作为独立命令，可将该模式存储到当前会话。
- 选项可以组合使用：`/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 或 `/queue reset` 清除会话覆盖。

## 作用范围与保证

- 适用于所有使用 Gateway网关回复管道的入站渠道的自动回复智能体运行（WhatsApp 网页版、Telegram、Slack、Discord、Signal、iMessage、网页聊天等）。
- 默认通道（`main`）在进程范围内适用于入站消息和主心跳；设置 `agents.defaults.maxConcurrent` 以允许多个会话并行。
- 可能存在其他通道（如 `cron`、`subagent`），以便后台任务可以并行运行而不阻塞入站回复。
- 按会话通道保证同一时间只有一个智能体运行接触给定会话。
- 无外部依赖或后台工作线程；纯 TypeScript + Promise 实现。

## 故障排除

- 如果命令似乎卡住，启用详细日志并查找 "queued for …ms" 行，以确认队列正在正常排空。
- 如果需要查看队列深度，启用详细日志并观察队列计时行。
