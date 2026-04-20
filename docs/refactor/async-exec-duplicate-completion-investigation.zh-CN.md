# 异步执行重复完成调查

## 范围

- 会话：`agent:main:telegram:group:-1003774691294:topic:1`
- 症状：会话/运行 `keen-nexus` 的相同异步执行完成在 LCM 中被记录为两次用户轮次。
- 目标：确定这最可能是重复会话注入还是简单的出站传递重试。

## 结论

这最可能是**重复会话注入**，而不是纯粹的出站传递重试。

网关端最强的漏洞在于**节点执行完成路径**：

1. 节点端执行完成发出 `exec.finished` 事件，带有完整的 `runId`。
2. 网关 `server-node-events` 将其转换为系统事件并请求心跳。
3. 心跳运行将排出的系统事件块注入到代理提示中。
4. 嵌入式运行器将该提示作为会话转录中的新用户轮次持久化。

如果同一个 `exec.finished` 由于任何原因（重放、重新连接重复、上游重发、重复生产者）为同一个 `runId` 两次到达网关，OpenClaw 目前在此路径上**没有按 `runId`/`contextKey` 键控的幂等性检查**。第二个副本将成为具有相同内容的第二条用户消息。

## 确切的代码路径

### 1. 生产者：节点执行完成事件

- `src/node-host/invoke.ts:340-360`
  - `sendExecFinishedEvent(...)` 发出带有 `exec.finished` 事件的 `node.event`。
  - 有效负载包括 `sessionKey` 和完整的 `runId`。

### 2. 网关事件摄取

- `src/gateway/server-node-events.ts:574-640`
  - 处理 `exec.finished`。
  - 构建文本：
    - `Exec finished (node=..., id=<runId>, code ...)`
  - 通过以下方式将其入队：
    - `enqueueSystemEvent(text, { sessionKey, contextKey: runId ? \`exec:${runId}\` : "exec", trusted: false })`
  - 立即请求唤醒：
    - `requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event" }))`

### 3. 系统事件去重弱点

- `src/infra/system-events.ts:90-115`
  - `enqueueSystemEvent(...)` 仅抑制**连续的重复文本**：
    - `if (entry.lastText === cleaned) return false`
  - 它存储 `contextKey`，但**不**使用 `contextKey` 进行幂等性检查。
  - 排出后，重复抑制重置。

这意味着带有相同 `runId` 的重放 `exec.finished` 稍后可以再次被接受，即使代码已经有了稳定的幂等性候选 (`exec:<runId>`)。

### 4. 唤醒处理不是主要的重复源

- `src/infra/heartbeat-wake.ts:79-117`
  - 唤醒按 `(agentId, sessionKey)` 合并。
  - 对同一目标的重复唤醒请求合并为一个待处理的唤醒条目。

这使得**单独的重复唤醒处理**成为比重复事件摄取更弱的解释。

### 5. 心跳消费事件并将其转换为提示输入

- `src/infra/heartbeat-runner.ts:535-574`
  - 预检查看待处理的系统事件并分类执行事件运行。
- `src/auto-reply/reply/session-system-events.ts:86-90`
  - `drainFormattedSystemEvents(...)` 排出会话的队列。
- `src/auto-reply/reply/get-reply-run.ts:400-427`
  - 排出的系统事件块被前置到代理提示正文中。

### 6. 转录注入点

- `src/agents/pi-embedded-runner/run/attempt.ts:2000-2017`
  - `activeSession.prompt(effectivePrompt)` 将完整提示提交到嵌入式 PI 会话。
  - 这是完成派生的提示成为持久化用户轮次的点。

因此，一旦相同的系统事件被两次重建到提示中，就会出现重复的 LCM 用户消息。

## 为什么纯出站传递重试可能性较小

心跳运行器中存在真实的出站失败路径：

- `src/infra/heartbeat-runner.ts:1194-1242`
  - 首先生成回复。
  - 稍后通过 `deliverOutboundPayloads(...)` 进行出站传递。
  - 那里的失败返回 `{ status: "failed" }`。

然而，对于相同的系统事件队列条目，这本身**不足以**解释重复的用户轮次：

- `src/auto-reply/reply/session-system-events.ts:86-90`
  - 系统事件队列在出站传递之前已经被排出。

因此，单独的通道发送重试不会重新创建完全相同的排队事件。它可以解释缺失/失败的外部传递，但本身不能解释第二条相同的会话用户消息。

## 次要的、较低置信度的可能性

代理运行器中有一个完整运行的重试循环：

- `src/auto-reply/reply/agent-runner-execution.ts:741-1473`
  - 某些临时故障可以重试整个运行并重新提交相同的 `commandBody`。

如果提示在触发重试条件之前已经被追加，这可能会**在同一回复执行中**重复持久化的用户提示。

我将此排在重复 `exec.finished` 摄取之后，因为：

- 观察到的间隙约为 51 秒，这看起来更像是第二次唤醒/轮次，而不是进程内重试；
- 报告已经提到重复的消息发送失败，这更指向单独的后续轮次，而不是立即的模型/运行时重试。

## 根本原因假设

最高置信度假设：

- `keen-nexus` 完成通过**节点执行事件路径**传递。
- 相同的 `exec.finished` 被传递到 `server-node-events` 两次。
- 网关接受两者，因为 `enqueueSystemEvent(...)` 不按 `contextKey` / `runId` 去重。
- 每个被接受的事件触发一次心跳，并作为用户轮次注入到 PI 转录中。

## 建议的微小外科修复

如果需要修复，最小的高价值更改是：

- 使执行/系统事件幂等性在短时间范围内尊重 `contextKey`，至少对于完全相同的 `(sessionKey, contextKey, text)` 重复；
- 或在 `server-node-events` 中为按 `(sessionKey, runId, event kind)` 键控的 `exec.finished` 添加专用去重。

这将直接在重复的 `exec.finished` 成为会话轮次之前阻止它们。
