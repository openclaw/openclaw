# Bash runtime tool fixture

```yaml qa-scenario
id: runtime-tool-bash
title: Runtime tool fixture — bash
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.bash
objective: Verify the bash tool family maps to a deterministic shell execution under both runtimes.
successCriteria:
  - Effective tools expose the OpenClaw shell execution surface.
  - The mock provider plans exactly one happy-path shell call.
  - The mock provider plans one denied-input failure-path shell call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/pi-tools.ts
  - src/agents/bash-tools.schemas.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the bash family through the OpenClaw exec tool.
  config:
    toolName: exec
    toolCoverage:
      family: bash
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
  - name: exercises bash happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
