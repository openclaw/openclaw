# File list runtime tool fixture

```yaml qa-scenario
id: runtime-tool-fs-list
title: Runtime tool fixture — fs.list
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.fs.list
objective: Verify directory-list style file inspection is covered through the current read surface.
successCriteria:
  - Effective tools expose the read surface used for directory inspection.
  - The mock provider plans exactly one happy-path read call.
  - The mock provider plans one denied-input failure-path read call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.read.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise fs.list coverage through the current read tool surface.
  config:
    toolName: read
    toolCoverage:
      family: fs.list
      actualTool: read
      tracking: "#80312"
      reason: Current OpenClaw coding surface has no separate list tool; QA mock failure-path capture currently reports provider-plan args, not proven Codex runtime args.
    knownHarnessGap:
      issue: "#80312"
      reason: QA mock failure-path capture currently reports provider-plan args, not proven Codex runtime args.
    promptSnippet: "target=read"
    failurePromptSnippet: "failure target=read"
```

```yaml qa-flow
steps:
  - name: exercises fs.list happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
