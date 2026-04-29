---
name: taskflow
description: Coordinate multi-step detached tasks as one durable TaskFlow job with owner context, state, waits, and child tasks.
metadata: { "openclaw": { "emoji": "🪝" } }
---

# TaskFlow

当一个任务需要超越一个提示或一次分离运行而存在时使用 TaskFlow，但您仍然希望有一个所有者会话、一个返回上下文和一个检查或恢复工作的地方。

## 何时使用

- 有一个所有者的多步骤后台工作
- 等待分离的 ACP 或子代理任务的工作
- 可能需要向所有者发出一个清晰更新的任务
- 需要在步骤之间保持小持久化状态的任务
- 必须干净地存活重启和修订冲突的插件或工具工作

## TaskFlow 拥有的内容

- flow 身份
- 所有者会话和请求者来源
- `currentStep`、`stateJson` 和 `waitJson`
- 链接的子任务及其父 flow id
- 完成、失败、取消、等待和阻止状态
- 冲突安全变更的修订跟踪

它**不**拥有分支或业务逻辑。将那些放在 Lobster、acpx 或调用代码中。

## 当前运行时形状

规范的插件/运行时入口点：

- `api.runtime.tasks.flow`
- `api.runtime.taskFlow` 作为别名仍然存在，但 `api.runtime.tasks.flow` 是规范形状

绑定：

- `api.runtime.tasks.flow.fromToolContext(ctx)` 当您已经拥有带有 `sessionKey` 的可信工具上下文时
- `api.runtime.tasks.flow.bindSession({ sessionKey, requesterOrigin })` 当您的绑定层已经解析了会话和传递上下文时

托管流程生命周期：

1. `createManaged(...)`
2. `runTask(...)`
3. `setWaiting(...)` 等待人员或外部系统时
4. `resume(...)` 工作可以继续时
5. `finish(...)` 或 `fail(...)`
6. `requestCancel(...)` 或 `cancel(...)` 当整个作业应该停止时

## 设计约束

- 当您的代码拥有编排时使用**托管** TaskFlows。
- 单任务**镜像**流程由核心运行时为分离的 ACP/子代理工作创建；此 skill 主要关于托管流程。
- 将 `stateJson` 视为持久化状态袋。没有单独的 `setFlowOutput` 或 `appendFlowOutput` API。
- 创建后的每个变更方法都经过修订检查。在每次成功变更后携带最新的 `flow.revision`。
- `runTask(...)` 将子任务链接到流程。当您想要父编排时使用它，而不是手动创建分离任务。

## 示例形状

```ts
const taskFlow = api.runtime.tasks.flow.fromToolContext(ctx);

const created = taskFlow.createManaged({
  controllerId: "my-plugin/inbox-triage",
  goal: "triage inbox",
  currentStep: "classify",
  stateJson: {
    businessThreads: [],
    personalItems: [],
    eodSummary: [],
  },
});

const classify = taskFlow.runTask({
  flowId: created.flowId,
  runtime: "acp",
  childSessionKey: "agent:main:subagent:classifier",
  runId: "inbox-classify-1",
  task: "Classify inbox messages",
  status: "running",
  startedAt: Date.now(),
  lastEventAt: Date.now(),
});

if (!classify.created) {
  throw new Error(classify.reason);
}

const waiting = taskFlow.setWaiting({
  flowId: created.flowId,
  expectedRevision: created.revision,
  currentStep: "await_business_reply",
  stateJson: {
    businessThreads: ["slack:thread-1"],
    personalItems: [],
    eodSummary: [],
  },
  waitJson: {
    kind: "reply",
    channel: "slack",
    threadKey: "slack:thread-1",
  },
});

if (!waiting.applied) {
  throw new Error(waiting.code);
}

const resumed = taskFlow.resume({
  flowId: waiting.flow.flowId,
  expectedRevision: waiting.flow.revision,
  status: "running",
  currentStep: "finalize",
  stateJson: waiting.flow.stateJson,
});

if (!resumed.applied) {
  throw new Error(resumed.code);
}

taskFlow.finish({
  flowId: resumed.flow.flowId,
  expectedRevision: resumed.flow.revision,
  stateJson: resumed.flow.stateJson,
});
```

## 在运行时上方保持条件

使用 flow 运行时进行状态和任务链接。将决策保持在创作层：

- `business` → 发布到 Slack 并等待
- `personal` → 立即通知所有者
- `later` → 附加到日终摘要桶

## 操作模式

- 仅存储恢复所需的最少状态。
- 将人类可读的等待原因放在 `blockedSummary` 或结构化元数据放在 `waitJson` 中。
- 当编排器需要子工作的紧凑健康视图时使用 `getTaskSummary(flowId)`。
- 当调用者希望 flow 立即停止调度时使用 `requestCancel(...)`。
- 当您也想取消活动链接的子任务时使用 `cancel(...)`。

## 示例

- 参见 `skills/taskflow/examples/inbox-triage.lobster`
- 参见 `skills/taskflow/examples/pr-intake.lobster`
- 参见 `skills/taskflow-inbox-triage/SKILL.md` 了解具体路由模式
