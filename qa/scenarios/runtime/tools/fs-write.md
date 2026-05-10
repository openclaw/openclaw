# File write runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-write
title: Runtime tool fixture — fs.write
surface: runtime-tools
coverage:
  primary:
    - tools.fs.write
objective: Verify file writes preserve arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose write.
  - The mock provider plans exactly one happy-path write call.
  - The mock provider plans one denied-input failure-path write call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.workspace-paths.test.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the write runtime tool family.
  config:
    toolName: write
    toolCoverage:
      family: fs.write
      actualTool: write
      tracking: "#80319"
      reason: Codex returns an acknowledgement without sending the planned write tool request.
    knownBroken:
      issue: "#80319"
      reason: Codex returns an acknowledgement without sending the planned write tool request.
    promptSnippet: "target=write"
    failurePromptSnippet: "failure target=write"
```

```yaml qa-flow
steps:
  - name: exercises fs.write happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
