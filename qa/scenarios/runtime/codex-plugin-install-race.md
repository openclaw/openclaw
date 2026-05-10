# Codex plugin install race

```yaml qa-scenario
id: codex-plugin-install-race
title: Codex plugin install race
surface: runtime
coverage:
  primary:
    - runtime.codex-plugin.lifecycle
  secondary:
    - runtime.turn-ordering
objective: Verify first agent turns wait on Codex plugin installation through deterministic ordering primitives, without sleep-based race assertions, lost tokens, or duplicate responses.
successCriteria:
  - The first turn records a waiting event before the install completion event.
  - The turn starts exactly once after the install completion event.
  - Input-token accounting survives the gate and responseCount remains 1.
docsRefs:
  - docs/cli/plugins.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for deterministic install-vs-first-turn ordering.
  config:
    expectedResponseCount: 1
    expectedText: QA_CODEX_PLUGIN_TURN_OK
```

```yaml qa-flow
steps:
  - name: records deterministic install-race fixture contract
    actions:
      - assert:
          expr: "config.expectedResponseCount === 1"
          message: "first turn must produce one response"
    detailsExpr: "`expected=${config.expectedText} count=${config.expectedResponseCount}`"
```
