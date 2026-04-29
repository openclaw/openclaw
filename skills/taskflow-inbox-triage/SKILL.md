---
name: taskflow-inbox-triage
description: Example TaskFlow pattern for inbox triage, intent routing, waiting on replies, and later summaries.
metadata: { "openclaw": { "emoji": "📥" } }
---

# TaskFlow 收件箱分类

这是一个关于如何思考 TaskFlow 但不将核心运行时变成 DSL 的具体示例。

## 目标

用一个所有者流程对收件箱项目进行分类：

- 业务 → 发布到 Slack 并等待回复
- 个人 → 立即通知所有者
- 其他所有 → 保留以供日终摘要

## 模式

1. 为收件箱批次创建一个流程。
2. 运行一个分离的任务来分类新项目。
3. 将路由状态持久化在 `stateJson` 中。
4. 仅在需要外部回复时移至 `waiting`。
5. 当分类或人工输入完成时恢复流程。
6. 当批次已被路由时完成。

## 建议的 `stateJson` 形状

```json
{
  "businessThreads": [],
  "personalItems": [],
  "eodSummary": []
}
```

在 Slack 上被阻止时的建议 `waitJson`：

```json
{
  "kind": "reply",
  "channel": "slack",
  "threadKey": "slack:thread-1"
}
```

## 最小运行时调用

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

const child = taskFlow.runTask({
  flowId: created.flowId,
  runtime: "acp",
  childSessionKey: "agent:main:subagent:classifier",
  task: "Classify inbox messages",
  status: "running",
  startedAt: Date.now(),
  lastEventAt: Date.now(),
});

if (!child.created) {
  throw new Error(child.reason);
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
  currentStep: "route_items",
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

## 相关示例

- `skills/taskflow/examples/inbox-triage.lobster`
