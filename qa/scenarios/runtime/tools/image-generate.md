# Image generation runtime tool fixture

```yaml qa-scenario
id: runtime-tool-image-generate
title: Runtime tool fixture — image_generate
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.image-generate
objective: Verify image_generate preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose image_generate after QA image-generation config is applied.
  - The mock provider plans exactly one happy-path image_generate call.
  - The mock provider plans one denied-input failure-path image_generate call.
docsRefs:
  - docs/tools/image-generation.md
codeRefs:
  - src/agents/tools/image-generate-tool.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the image_generate runtime tool family.
  config:
    toolName: image_generate
    ensureImageGeneration: true
    toolCoverage:
      family: image_generate
      actualTool: image_generate
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: teach fixture/mock planner Codex searchable OpenClaw dynamic tool behavior
      reason: image_generate is an OpenClaw integration tool; QA mock provider does not yet model Codex searchable/deferred dynamic tool declarations for this fixture.
    knownHarnessGap:
      issue: "#80319"
      reason: QA mock provider does not yet model Codex searchable/deferred OpenClaw dynamic tool declarations for this fixture.
    promptSnippet: "target=image_generate"
    failurePromptSnippet: "failure target=image_generate"
```

```yaml qa-flow
steps:
  - name: exercises image_generate happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
