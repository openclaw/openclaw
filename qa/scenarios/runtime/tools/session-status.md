# Session status runtime tool fixture

```yaml qa-scenario
id: runtime-tool-session-status
title: Runtime tool fixture — session_status
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.session-status
objective: Verify session_status preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose session_status.
  - The mock provider plans exactly one happy-path session_status call.
  - The mock provider plans one denied-input failure-path session_status call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/session-status-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the session_status runtime tool family.
  config:
    toolName: session_status
    toolCoverage:
      family: session_status
      actualTool: session_status
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: teach fixture/mock planner Codex searchable OpenClaw dynamic tool behavior
      reason: session_status is an OpenClaw integration tool; QA mock provider does not yet model Codex searchable/deferred dynamic tool declarations for this fixture.
    knownHarnessGap:
      issue: "#80319"
      reason: QA mock provider does not yet model Codex searchable/deferred OpenClaw dynamic tool declarations for this fixture.
    promptSnippet: "target=session_status"
    failurePromptSnippet: "failure target=session_status"
```

```yaml qa-flow
steps:
  - name: exercises session_status happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
