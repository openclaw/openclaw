---
summary: "Unified governance contract for OpenClaw, Claude, and Codex task execution."
read_when:
  - You need one shared execution policy across OpenClaw, Claude, and Codex
  - You are deciding whether a task can start or must be blocked
  - You are validating autonomous safety, evidence, and release readiness
title: "Unified Governance R8.1"
---

# Unified Governance R8.1

`R8.1` is the single decision core for OpenClaw, Claude, and Codex.

## Mandatory order

1. Complete full-module blueprint (`FMBG`) first.
2. Allow single-ticket execution only after blueprint passes.
3. Simulate before completion.
4. If failed, fix immediately and rerun the same case.
5. Block completion when evidence is incomplete.
6. Block completion when any `P0/P1` remains.

## Gates

- `FMBG` (full-module blueprint gate): module/dependency/contract/test/rollback coverage must all be `100%`.
- `VFC` (verify-fix-close): same-round fix for `P0/P1`, same-case rerun, regression pass.
- `Release gate` (for `L2`): canary + auto-rollback verification are mandatory.
- `SCCP` (shortest correct code policy): choose shorter implementation only when correctness is equal.

## Rule-upgrade validation thresholds

Before promoting a new rule version:

- simulations: `>= 500`
- fail rate: `<= 2.0%`
- escape rate: `<= 2.0%`
- rollout incident rate: `<= 0.5%`
- flaky false block rate: `<= 1.0%`

## Machine-readable source of truth

- `config/openclaw-unified-governance-r8.1.json`

## Verification command

```bash
pnpm governance:r8:check
```
