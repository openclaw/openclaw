---
summary: "代理循环生命周期、流和等待语义"
read_when:
  - 你需要代理循环或生命周期事件的详细讲解
  - 你想了解 OpenClaw 中代理如何处理消息和工具执行
  - 你需要理解代理的并发和队列机制
---

# 代理循环（OpenClaw）

代理循环是代理的完整"真实"运行：输入 → 上下文组装 → 模型推理 → 工具执行 → 流式回复 → 持久化。这是将消息转换为操作和最终回复的权威路径，同时保持会话状态一致。

在 OpenClaw 中，循环是每个会话的单个序列化运行，在模型思考、调用工具和流式输出时发出生命周期和流事件。本文档解释了这个真实循环是如何端到端连接的。

## 入口点

- 网关 RPC: `agent` 和 `agent.wait`。
- CLI: `agent` 命令。

## 工作原理（高级）

1. `agent` RPC 验证参数，解析会话（sessionKey/sessionId），持久化会话元数据，立即返回 `{ runId, acceptedAt }`。
2. `agentCommand` 运行代理：
   - 解析模型 + 思考/详细/跟踪默认值
   - 加载技能快照
   - 调用 `runEmbeddedPiAgent`（pi-agent-core 运行时）
   - 如果嵌入循环不发出生命周期结束/错误，则发出**生命周期结束/错误**
3. `runEmbeddedPiAgent`：
   - 通过每会话 + 全局队列序列化运行
   - 解析模型 + 认证配置文件并构建 pi 会话
   - 订阅 pi 事件并流式传输助手/工具增量
   - 强制执行超时 → 如果超过则中止运行
   - 返回有效载荷 + 使用元数据
4. `subscribeEmbeddedPiSession` 将 pi-agent-core 事件桥接到 OpenClaw `agent` 流：
   - 工具事件 => `stream: "tool"`
   - 助手增量 => `stream: "assistant"`
   - 生命周期事件 => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` 使用 `waitForAgentRun`：
   - 等待 `runId` 的**生命周期结束/错误**
   - 返回 `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## 队列 + 并发

- 运行按会话键（会话通道）序列化，可选地通过全局通道。
- 这可以防止工具/会话竞争并保持会话历史一致。
- 消息通道可以选择队列模式（collect/steer/followup），为这个通道系统提供输入。
  请参阅 [命令队列](/concepts/queue)。

## 会话 + 工作区准备

- 工作区被解析和创建；沙盒运行可能重定向到沙盒工作区根目录。
- 技能被加载（或从快照中重用）并注入到环境和提示中。
- 引导/上下文文件被解析并注入到系统提示报告中。
- 获得会话写锁；在流式传输之前打开并准备 `SessionManager`。

## 提示组装 + 系统提示

- 系统提示由 OpenClaw 的基本提示、技能提示、引导上下文和每次运行的覆盖构建。
- 强制执行模型特定的限制和压缩保留令牌。
- 有关模型看到的内容，请参阅 [系统提示](/concepts/system-prompt)。

## 钩子点（你可以拦截的地方）

OpenClaw 有两个钩子系统：

- **内部钩子**（网关钩子）：命令和生命周期事件的事件驱动脚本。
- **插件钩子**：代理/工具生命周期和网关管道内的扩展点。

### 内部钩子（网关钩子）

- **`agent:bootstrap`**：在系统提示最终确定之前构建引导文件时运行。
  使用此选项添加/删除引导上下文文件。
- **命令钩子**：`/new`、`/reset`、`/stop` 和其他命令事件（参见钩子文档）。

有关设置和示例，请参阅 [钩子](/automation/hooks)。

### 插件钩子（代理 + 网关生命周期）

这些在代理循环或网关管道内运行：

- **`before_model_resolve`**：在会话前运行（无 `messages`），在模型解析前确定性地覆盖提供商/模型。
- **`before_prompt_build`**：在会话加载后运行（带 `messages`），在提示提交前注入 `prependContext`、`systemPrompt`、`prependSystemContext` 或 `appendSystemContext`。使用 `prependContext` 作为每轮动态文本，使用系统上下文字段作为应该位于系统提示空间中的稳定指导。
- **`before_agent_start`**：可能在任一阶段运行的遗留兼容钩子；优先使用上面的显式钩子。
- **`before_agent_reply`**：在内联操作之后和 LLM 调用之前运行，允许插件声明轮次并返回合成回复或完全静默轮次。
- **`agent_end`**：在完成后检查最终消息列表和运行元数据。
- **`before_compaction` / `after_compaction`**：观察或注释压缩周期。
- **`before_tool_call` / `after_tool_call`**：拦截工具参数/结果。
- **`before_install`**：检查内置扫描结果并可选地阻止技能或插件安装。
- **`tool_result_persist`**：在工具结果写入会话记录之前同步转换它们。
- **`message_received` / `message_sending` / `message_sent`**：入站 + 出站消息钩子。
- **`session_start` / `session_end`**：会话生命周期边界。
- **`gateway_start` / `gateway_stop`**：网关生命周期事件。

出站/工具防护的钩子决策规则：

- `before_tool_call`：`{ block: true }` 是终端的，会停止低优先级处理程序。
- `before_tool_call`：`{ block: false }` 是无操作的，不会清除先前的阻止。
- `before_install`：`{ block: true }` 是终端的，会停止低优先级处理程序。
- `before_install`：`{ block: false }` 是无操作的，不会清除先前的阻止。
- `message_sending`：`{ cancel: true }` 是终端的，会停止低优先级处理程序。
- `message_sending`：`{ cancel: false }` 是无操作的，不会清除先前的取消。

有关钩子 API 和注册详细信息，请参阅 [插件钩子](/plugins/architecture#provider-runtime-hooks)。

## 流式传输 + 部分回复

- 助手增量从 pi-agent-core 流式传输并作为 `assistant` 事件发出。
- 块流式传输可以在 `text_end` 或 `message_end` 上发出部分回复。
- 推理流式传输可以作为单独的流或块回复发出。
- 有关分块和块回复行为，请参阅 [流式传输](/concepts/streaming)。

## 工具执行 + 消息工具

- 工具开始/更新/结束事件在 `tool` 流上发出。
- 工具结果在记录/发出之前会针对大小和图像有效载荷进行清理。
- 消息工具发送会被跟踪以抑制重复的助手确认。

## 回复塑造 + 抑制

- 最终有效载荷由以下部分组装：
  - 助手文本（和可选的推理）
  - 内联工具摘要（当详细且允许时）
  - 模型出错时的助手错误文本
- 确切的静默令牌 `NO_REPLY` / `no_reply` 从出站有效载荷中过滤。
- 消息工具重复项从最终有效载荷列表中删除。
- 如果没有可渲染的有效载荷剩余且工具出错，则会发出回退工具错误回复
  （除非消息工具已经发送了用户可见的回复）。

## 压缩 + 重试

- 自动压缩发出 `compaction` 流事件并可能触发重试。
- 在重试时，内存缓冲区和工具摘要会重置以避免重复输出。
- 有关压缩管道，请参阅 [压缩](/concepts/compaction)。

## 事件流（当前）

- `lifecycle`：由 `subscribeEmbeddedPiSession` 发出（并作为 `agentCommand` 的回退）
- `assistant`：来自 pi-agent-core 的流式增量
- `tool`：来自 pi-agent-core 的流式工具事件

## 聊天通道处理

- 助手增量被缓冲到聊天 `delta` 消息中。
- 聊天 `final` 在**生命周期结束/错误**时发出。

## 超时

- `agent.wait` 默认值：30s（仅等待）。`timeoutMs` 参数覆盖。
- 代理运行时：`agents.defaults.timeoutSeconds` 默认 172800s（48 小时）；在 `runEmbeddedPiAgent` 中止计时器中强制执行。
- LLM 空闲超时：`agents.defaults.llm.idleTimeoutSeconds` 在空闲窗口之前没有响应块到达时中止模型请求。为慢速本地模型或推理/工具调用提供商显式设置；设置为 0 以禁用。如果未设置，OpenClaw 在配置时使用 `agents.defaults.timeoutSeconds`，否则使用 120s。没有显式 LLM 或代理超时的 cron 触发运行会禁用空闲看门狗并依赖于 cron 外部超时。

## 可能提前结束的地方

- 代理超时（中止）
- AbortSignal（取消）
- 网关断开连接或 RPC 超时
- `agent.wait` 超时（仅等待，不停止代理）

## 相关

- [工具](/tools) — 可用的代理工具
- [钩子](/automation/hooks) — 由代理生命周期事件触发的事件驱动脚本
- [压缩](/concepts/compaction) — 长对话如何被总结
- [执行批准](/tools/exec-approvals) — shell 命令的批准门
- [思考](/tools/thinking) — 思考/推理级别配置
