# Model switch follow-up

```yaml qa-scenario
id: model-switch-follow-up
title: Model switch follow-up
surface: models
objective: Verify the agent can switch to a different configured model and continue coherently.
successCriteria:
  - Agent reflects the model switch request.
  - Follow-up answer remains coherent with prior context.
  - Final report notes whether the switch actually happened.
docsRefs:
  - docs/help/testing.md
  - docs/web/dashboard.md
codeRefs:
  - extensions/qa-lab/src/report.ts
execution:
  kind: custom
  handler: model-switch-follow-up
  summary: Verify the agent can switch to a different configured model and continue coherently.
  config:
    initialPrompt: "Say hello from the default configured model."
    followupPrompt: "Continue the exchange after switching models and note the handoff."
```
