# File read runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-read
title: Runtime tool fixture — fs.read
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.fs.read
objective: Verify file reads preserve arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose read.
  - The mock provider plans exactly one happy-path read call.
  - The mock provider plans one denied-input failure-path read call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.read.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the read runtime tool family.
  config:
    toolName: read
    toolCoverage:
      family: fs.read
      actualTool: read
      tracking: "#80312"
      reason: QA mock failure-path capture currently reports provider-plan args, not proven Codex runtime args.
    knownHarnessGap:
      issue: "#80312"
      reason: QA mock failure-path capture currently reports provider-plan args, not proven Codex runtime args.
    promptSnippet: "target=read"
    failurePromptSnippet: "failure target=read"
```

```yaml qa-flow
steps:
  - name: exercises fs.read happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
