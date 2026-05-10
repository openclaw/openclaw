# Grep runtime tool fixture

```yaml qa-scenario
id: runtime-tool-grep
title: Runtime tool fixture — grep
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.grep
objective: Verify grep-style search remains covered through the current shell execution surface.
successCriteria:
  - Effective tools expose exec for grep-style shell searches.
  - The mock provider plans exactly one happy-path exec call.
  - The mock provider plans one denied-input failure-path exec call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise grep coverage through the current exec tool surface.
  config:
    toolName: exec
    toolCoverage:
      family: grep
      actualTool: exec
      tracking: "#80319"
      reason: Current OpenClaw coding surface routes grep-style searches through exec; QA mock provider does not yet model Codex native/searchable tool declarations for this fixture.
    knownHarnessGap:
      issue: "#80319"
      reason: QA mock provider does not yet model Codex native/searchable tool declarations for this fixture.
    promptSnippet: "target=exec"
    failurePromptSnippet: "failure target=exec"
```

```yaml qa-flow
steps:
  - name: exercises grep happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
