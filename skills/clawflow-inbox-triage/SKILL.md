---
name: clawflow-inbox-triage
description: Example ClawFlow authoring pattern for inbox triage. Use when messages need different treatment based on intent, with some routes notifying immediately, some waiting on outside answers, and others rolling into a later summary.
metadata: { "openclaw": { "emoji": "📥" } }
---

# ClawFlow inbox triage

This is a concrete example of how to think about ClawFlow without turning the core runtime into a DSL.

## Goal

Triage inbox items with one owner flow:

- business → post to Slack and wait for reply
- personal → notify the owner now
- everything else → keep for end-of-day summary

## Pattern

1. Create one flow for the inbox batch.
2. Run one detached task to classify new items.
3. Resume the flow when classification completes.
4. Route each item in the calling logic.
5. Persist only the summary bucket and the current wait target.

## Suggested flow outputs

- `business_threads`
- `personal_items`
- `eod_summary`

## Minimal runtime calls

```ts
const flow = createFlow({
  ownerSessionKey,
  goal: "triage inbox",
});

runTaskInFlow({
  flowId: flow.flowId,
  runtime: "acp",
  task: "Classify inbox messages",
  currentStep: "wait_for_classification",
});

resumeFlow({
  flowId: flow.flowId,
  currentStep: "route_items",
});

appendFlowOutput({
  flowId: flow.flowId,
  key: "eod_summary",
  value: { subject: "Newsletter", route: "later" },
});
```

## Related example

- `skills/clawflow/examples/inbox-triage.lobster`
