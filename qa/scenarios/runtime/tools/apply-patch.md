# Apply patch runtime tool fixture

```yaml qa-scenario
id: runtime-tool-apply-patch
title: Runtime tool fixture — apply-patch
surface: runtime-tools
coverage:
  primary:
    - tools.apply-patch
objective: Verify apply_patch preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose apply_patch.
  - The mock provider plans exactly one happy-path apply_patch call.
  - The mock provider plans one denied-input failure-path apply_patch call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/apply-patch.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the apply_patch runtime tool family.
  config:
    toolName: apply_patch
    toolCoverage:
      family: apply-patch
      actualTool: apply_patch
      tracking: "#80320"
      reason: Pi omits apply_patch from the effective runtime tool surface while Codex exposes it.
    knownBroken:
      issue: "#80320"
      reason: Pi omits apply_patch from the effective runtime tool surface while Codex exposes it.
    promptSnippet: "target=apply_patch"
    failurePromptSnippet: "failure target=apply_patch"
```

```yaml qa-flow
steps:
  - name: exercises apply_patch happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
