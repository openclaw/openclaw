---
read_when:
  - 你需要智能体循环或生命周期事件的详细说明
summary: 智能体循环生命周期、流和等待语义
title: 智能体循环
x-i18n:
  generated_at: "2026-02-01T20:22:03Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0775b96eb3451e137297661a1095eaefb2bafeebb5f78123174a46290e18b014
  source_path: concepts/agent-loop.md
  workflow: 14
---

# 智能体循环（OpenClaw）

智能体循环是智能体的一次完整"真实"运行：接收 → 上下文组装 → 模型推理 →
工具执行 → 流式回复 → 持久化。它是将消息转化为操作和最终回复的权威路径，同时保持会话状态的一致性。

在 OpenClaw 中，循环是每个会话的单次序列化运行，在模型思考、调用工具和流式输出时发出生命周期和流事件。本文档解释了这个完整循环是如何端到端连接的。

## 入口点

- Gateway网关 RPC：`agent` 和 `agent.wait`。
- CLI：`agent` 命令。

## 工作原理（高层概述）

1. `agent` RPC 验证参数，解析会话（sessionKey/sessionId），持久化会话元数据，立即返回 `{ runId, acceptedAt }`。
2. `agentCommand` 运行智能体：
   - 解析模型 + thinking/verbose 默认值
   - 加载 Skills 快照
   - 调用 `runEmbeddedPiAgent`（pi-agent-core 运行时）
   - 如果嵌入式循环未发出**生命周期 end/error** 事件，则补充发出
3. `runEmbeddedPiAgent`：
   - 通过每会话 + 全局队列序列化运行
   - 解析模型 + 认证配置并构建 pi 会话
   - 订阅 pi 事件并流式传输助手/工具增量
   - 强制执行超时 -> 超时则中止运行
   - 返回载荷 + 使用量元数据
4. `subscribeEmbeddedPiSession` 将 pi-agent-core 事件桥接到 OpenClaw `agent` 流：
   - 工具事件 => `stream: "tool"`
   - 助手增量 => `stream: "assistant"`
   - 生命周期事件 => `stream: "lifecycle"`（`phase: "start" | "end" | "error"`）
5. `agent.wait` 使用 `waitForAgentJob`：
   - 等待 `runId` 的**生命周期 end/error**
   - 返回 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 队列 + 并发

- 运行按会话键（会话通道）序列化，并可选择通过全局通道进行。
- 这可以防止工具/会话竞争并保持会话历史的一致性。
- 消息渠道可以选择队列模式（collect/steer/followup）来供给此通道系统。
  参见[命令队列](/concepts/queue)。

## 会话 + 工作区准备

- 工作区被解析并创建；沙箱运行可能会重定向到沙箱工作区根目录。
- Skills 被加载（或从快照中复用）并注入到环境和提示中。
- 引导/上下文文件被解析并注入到系统提示报告中。
- 获取会话写锁；在流式传输之前打开并准备 `SessionManager`。

## 提示组装 + 系统提示

- 系统提示由 OpenClaw 的基础提示、Skills 提示、引导上下文和每次运行的覆盖项构建而成。
- 强制执行模型特定的限制和压缩预留令牌数。
- 参见[系统提示](/concepts/system-prompt)了解模型所看到的内容。

## 钩子点（可拦截的位置）

OpenClaw 有两个钩子系统：

- **内部钩子**（Gateway网关钩子）：用于命令和生命周期事件的事件驱动脚本。
- **插件钩子**：智能体/工具生命周期和 Gateway网关管道中的扩展点。

### 内部钩子（Gateway网关钩子）

- **`agent:bootstrap`**：在系统提示最终确定之前构建引导文件时运行。
  用于添加/移除引导上下文文件。
- **命令钩子**：`/new`、`/reset`、`/stop` 和其他命令事件（参见钩子文档）。

参见[钩子](/hooks)了解设置和示例。

### 插件钩子（智能体 + Gateway网关生命周期）

这些在智能体循环或 Gateway网关管道内运行：

- **`before_agent_start`**：在运行开始前注入上下文或覆盖系统提示。
- **`agent_end`**：在完成后检查最终消息列表和运行元数据。
- **`before_compaction` / `after_compaction`**：观察或标注压缩周期。
- **`before_tool_call` / `after_tool_call`**：拦截工具参数/结果。
- **`tool_result_persist`**：在工具结果写入会话记录之前同步转换工具结果。
- **`message_received` / `message_sending` / `message_sent`**：入站 + 出站消息钩子。
- **`session_start` / `session_end`**：会话生命周期边界。
- **`gateway_start` / `gateway_stop`**：Gateway网关生命周期事件。

参见[插件](/plugin#plugin-hooks)了解钩子 API 和注册详情。

## 流式传输 + 部分回复

- 助手增量从 pi-agent-core 流式传输并作为 `assistant` 事件发出。
- 块流式传输可以在 `text_end` 或 `message_end` 时发出部分回复。
- 推理流式传输可以作为单独的流或作为块回复发出。
- 参见[流式传输](/concepts/streaming)了解分块和块回复行为。

## 工具执行 + 消息工具

- 工具的 start/update/end 事件在 `tool` 流上发出。
- 工具结果在记录/发出之前会针对大小和图片载荷进行清理。
- 消息工具的发送会被跟踪，以抑制重复的助手确认。

## 回复整形 + 抑制

- 最终载荷由以下内容组装：
  - 助手文本（及可选的推理内容）
  - 内联工具摘要（当 verbose + 允许时）
  - 模型出错时的助手错误文本
- `NO_REPLY` 被视为静默令牌，从传出载荷中过滤。
- 消息工具的重复项从最终载荷列表中移除。
- 如果没有可渲染的载荷且工具出错，则发出回退的工具错误回复
  （除非消息工具已发送了用户可见的回复）。

## 压缩 + 重试

- 自动压缩发出 `compaction` 流事件，并可能触发重试。
- 重试时，内存缓冲区和工具摘要会被重置以避免重复输出。
- 参见[压缩](/concepts/compaction)了解压缩管道。

## 事件流（当前）

- `lifecycle`：由 `subscribeEmbeddedPiSession` 发出（以及作为 `agentCommand` 的回退）
- `assistant`：来自 pi-agent-core 的流式增量
- `tool`：来自 pi-agent-core 的流式工具事件

## 聊天渠道处理

- 助手增量被缓冲为聊天 `delta` 消息。
- 在**生命周期 end/error** 时发出聊天 `final`。

## 超时

- `agent.wait` 默认值：30 秒（仅等待阶段）。`timeoutMs` 参数可覆盖。
- 智能体运行时：`agents.defaults.timeoutSeconds` 默认 600 秒；在 `runEmbeddedPiAgent` 中止计时器中强制执行。

## 可能提前结束的情况

- 智能体超时（中止）
- AbortSignal（取消）
- Gateway网关断开连接或 RPC 超时
- `agent.wait` 超时（仅等待阶段，不会停止智能体）
