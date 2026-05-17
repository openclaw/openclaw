# Web search runtime tool fixture

```yaml qa-scenario
id: runtime-tool-web-search
title: Runtime tool fixture — web_search
surface: runtime-tools
runtimeParityTier: standard
coverage:
  primary:
    - tools.web-search
objective: Verify web_search preserves arguments and result shape across Pi and Codex.
successCriteria:
  - Effective tools expose web_search.
  - The mock provider plans exactly one happy-path web_search call.
  - The mock provider plans one denied-input failure-path web_search call.
docsRefs:
  - qa/scenarios/index.md
codeRefs:
  - src/agents/tools/web-search.ts
  - extensions/qa-lab/src/runtime-tool-fixture.ts
execution:
  kind: flow
  summary: Exercise the web_search runtime tool family.
  config:
    toolName: web_search
    toolCoverage:
      family: web_search
      actualTool: web_search
      bucket: openclaw-dynamic-integration
      expectedLayer: openclaw-dynamic
      required: true
      tracking: "#80319"
      codexDefaultImpact: P4
      qaImpact: P1
      action: teach fixture/mock planner Codex searchable OpenClaw dynamic tool behavior
      reason: web_search is an OpenClaw integration tool; QA mock provider does not yet model Codex searchable/deferred dynamic tool declarations for this fixture.
    knownHarnessGap:
      issue: "#80319"
      reason: QA mock provider does not yet model Codex searchable/deferred OpenClaw dynamic tool declarations for this fixture.
    promptSnippet: "target=web_search"
    failurePromptSnippet: "failure target=web_search"
```

```yaml qa-flow
steps:
  - name: exercises web_search happy and failure paths
    actions:
      - call: runRuntimeToolFixture
        saveAs: result
        args:
          - ref: env
          - ref: config
    detailsExpr: result
```
