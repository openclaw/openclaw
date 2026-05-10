# Message runtime tool fixture

```yaml qa-scenario
id: runtime-tool-message-tool
title: Runtime tool fixture — message-tool
surface: runtime-tools
coverage:
  primary:
    - tools.message-tool
objective: Verify the message tool preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose message.
  - The mock provider plans exactly one happy-path message call.
  - The mock provider plans one denied-input failure-path message call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/message-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the message runtime tool family.
  config:
    toolName: message
    toolCoverage:
      family: message-tool
      actualTool: message
      tracking: "#80321"
      reason: Neither runtime exposes message as an effective tool; current tool surface exposes sessions_send instead.
    knownBroken:
      issue: "#80321"
      reason: Neither runtime exposes message as an effective tool; current tool surface exposes sessions_send instead.
    promptSnippet: "target=message"
    failurePromptSnippet: "failure target=message"
```

```yaml qa-flow
steps:
  - name: exercises message happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
