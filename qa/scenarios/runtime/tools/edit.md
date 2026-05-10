# Edit runtime tool fixture

```yaml qa-scenario
id: runtime-tool-edit
title: Runtime tool fixture — edit
surface: runtime-tools
coverage:
  primary:
    - tools.edit
objective: Verify targeted file edits preserve arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose edit.
  - The mock provider plans exactly one happy-path edit call.
  - The mock provider plans one denied-input failure-path edit call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the edit runtime tool family.
  config:
    toolName: edit
    toolCoverage:
      family: edit
      actualTool: edit
      tracking: "#80319"
      reason: Codex returns an acknowledgement without sending the planned edit tool request.
    knownBroken:
      issue: "#80319"
      reason: Codex returns an acknowledgement without sending the planned edit tool request.
    promptSnippet: "target=edit"
    failurePromptSnippet: "failure target=edit"
```

```yaml qa-flow
steps:
  - name: exercises edit happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
