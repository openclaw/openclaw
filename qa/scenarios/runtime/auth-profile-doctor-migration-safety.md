# Codex doctor migration safety matrix

```yaml qa-scenario
id: auth-profile-doctor-migration-safety
title: Codex doctor migration safety matrix
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.doctor-repair
  secondary:
    - runtime.codex-plugin.auth
objective: Reproduce the four manual doctor-migration cells as an automated fixture matrix for Codex OAuth selection and stale Pi runtime pin removal.
successCriteria:
  - OAuth-only hosts select the openai-codex OAuth profile and use the Codex harness.
  - Mixed-profile hosts still select openai-codex OAuth when an openai API-key profile exists.
  - Mixed-profile defaults-level pi runtime pins are stripped by doctor repair.
  - Mixed-profile per-agent pi runtime pins are stripped by doctor repair.
docsRefs:
  - docs/cli/doctor.md
codeRefs:
  - extensions/qa-lab/src/auth-profile-fixture.ts
  - extensions/qa-lab/src/codex-plugin-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for ai-hpc's four-cell doctor migration matrix.
  config:
    matrixCells:
      - oauth-only
      - mixed-no-pin
      - mixed-defaults-pi-pin
      - mixed-main-agent-pi-pin
```

```yaml qa-flow
steps:
  - name: records doctor migration safety matrix fixture contract
    actions:
      - assert:
          expr: "config.matrixCells.length === 4"
          message: "expected four doctor migration cells"
    detailsExpr: "`cells=${config.matrixCells.join(',')}`"
```
