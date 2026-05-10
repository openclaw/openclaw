# Exec runtime tool fixture

```yaml qa-scenario
id: runtime-tool-exec
title: Runtime tool fixture — exec
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.exec
objective: Verify exec plans and completes with equivalent arguments and result shape under both runtimes.
successCriteria:
  - Effective tools expose exec.
  - The mock provider plans exactly one happy-path exec call.
  - The mock provider plans one denied-input failure-path exec call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/bash-tools.schemas.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the exec runtime tool family.
  config:
    toolName: exec
    toolCoverage:
      family: exec
      actualTool: exec
      tracking: "#80319"
      reason: Codex returns an acknowledgement without sending the planned exec tool request.
    knownBroken:
      issue: "#80319"
      reason: Codex returns an acknowledgement without sending the planned exec tool request.
    promptSnippet: "target=exec"
    failurePromptSnippet: "failure target=exec"
```

```yaml qa-flow
steps:
  - name: exercises exec happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
