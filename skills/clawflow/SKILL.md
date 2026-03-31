---
name: clawflow
description: Use when work should span one or more detached tasks but still behave like one job with a single owner context. ClawFlow is the runtime substrate under authoring layers like Lobster, acpx, or plain code. Keep conditional logic in the caller; use ClawFlow for flow identity, waiting, outputs, and user-facing emergence.
metadata: { "openclaw": { "emoji": "🪝" } }
---

# ClawFlow

Use ClawFlow when a job needs to outlive one prompt or one detached run, but you still want one owner session, one thread context, and one place to inspect or resume the work.

## When to use it

- Multi-step background work with one owner
- Work that waits on detached ACP or subagent tasks
- Jobs that may need to emit one clear update back to the owner
- Jobs that need a small persisted output bag between steps

## What ClawFlow owns

- flow identity
- owner session and return context
- waiting state
- small persisted outputs
- finish, fail, cancel, and blocked state

It does **not** own branching or business logic. Put that in Lobster, acpx, or the calling code.

## Runtime pattern

1. `createFlow(...)`
2. `runTaskInFlow(...)`
3. `setFlowWaiting(...)` or `setFlowOutput(...)`
4. `resumeFlow(...)`
5. `emitFlowUpdate(...)` only when needed
6. `finishFlow(...)` or `failFlow(...)`

## Example shape

```ts
const flow = createFlow({
  ownerSessionKey,
  goal: "triage inbox",
});

const classify = runTaskInFlow({
  flowId: flow.flowId,
  runtime: "acp",
  task: "Classify inbox messages",
  currentStep: "wait_for_classification",
});

resumeFlow({
  flowId: flow.flowId,
  currentStep: "route_results",
});

setFlowOutput({
  flowId: flow.flowId,
  key: "classification",
  value: { route: "business" },
});
```

## Keep conditionals above the runtime

Use the flow runtime for state and task linkage. Keep decisions in the authoring layer:

- `business` → post to Slack and wait
- `personal` → notify the owner now
- `later` → append to an end-of-day summary bucket

## Examples

- See `skills/clawflow/examples/inbox-triage.lobster`
- See `skills/clawflow/examples/pr-intake.lobster`
- See `skills/clawflow-inbox-triage/SKILL.md` for a concrete routing pattern
