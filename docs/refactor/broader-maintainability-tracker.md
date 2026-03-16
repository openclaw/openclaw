---
summary: "Execution tracker for the broader maintainability refactor plan"
read_when:
  - Tracking staged runtime and architecture maintainability work
  - Confirming scope guardrails and current stage status
title: "Broader Maintainability Tracker"
---

# Broader maintainability tracker

Current status:

- Stage 0 complete
- Stage 1A complete
- Stage 1B complete
- Stage 2A initial deterministic-read seam complete
- Stage 2B startup-threaded container seam complete
- Stage 3A in progress (startup phases extracted and covered with focused tests)
- Stages 3B to 5 not started

## Protected runtime slice

Do not edit these files under this plan:

- `extensions/telegram/src/bot-native-commands.ts`
- `extensions/telegram/src/bot-native-commands.test.ts`
- `src/auto-reply/commands-registry.data.ts`
- `src/auto-reply/commands-registry.test.ts`
- `scripts/telegram-e2e/*`
- `scripts/telegram-live-preflight.sh`

## Checklist

### Stage 0: docs and scope lock

- [x] Create `docs/refactor/broader-maintainability-plan.md`
- [x] Create `docs/refactor/broader-maintainability-tracker.md`
- [x] Record the protected runtime slice list
- [x] Record explicit staged goals, risks, and acceptance scenarios

### Stage 1A: CLI preflight unification

- [x] Add shared `prepareCliExecution()` preflight helper
- [x] Route-first path uses shared preflight
- [x] Commander preAction path uses shared preflight
- [x] Add parity tests for shared preflight behavior

### Stage 1B: runtime identity diagnostics

- [x] Add shared runtime fingerprint helper with standard fields
- [x] Emit runtime identity during gateway startup logs
- [x] Include runtime fingerprint in daemon status and gateway status output
- [x] Add focused tests for diagnostics output and JSON shape

### Stage 2A: config read and write determinism

- [x] Split config read and validate from mutation APIs
- [x] Prove `loadConfig()` does not write files
- [x] Add deterministic tests for read-only config paths

### Stage 2B: global state registry hardening

- [x] Introduce first `RuntimeStateContainer` seam in `runtime-overrides`
- [x] Introduce `RuntimeStateContainer` in startup path
- [x] Keep compatibility adapters for existing globals
- [x] Add tests for container lifecycle and order

### Stage 3A: gateway startup decomposition

- [x] Extract startup config preflight phase
- [x] Extract startup secrets precheck phase
- [x] Extract startup auth bootstrap phase
- [x] Extract startup runtime policy phase
- [x] Extract control UI root resolution phase
- [x] Extract secrets activation controller seam
- [x] Extract runtime config reloader wiring seam
- [ ] Pass typed context phase to phase
- [ ] Add phase failure classification tests

### Stage 3B: onboarding flow consolidation

- [ ] Define shared `OnboardingPlan` decision graph
- [ ] Keep separate interactive and non-interactive executors
- [ ] Add parity coverage for equivalent inputs

### Stage 4: routing and plugin boundary cleanup

- [ ] Extract route index matcher cache boundaries
- [ ] Narrow plugin runtime surface with capability facades
- [ ] Preserve external behavior parity

### Stage 5: guardrails and enforceability

- [ ] Add checks to block implicit config writes on read paths
- [ ] Add checks to block duplicate preflight path drift
- [ ] Add checks around unapproved `process.env` mutation paths

## Notes

- Keep runtime-worktree isolation strict.
- If unrelated changes appear, work around them. Do not revert other contributors.
- Do not touch `docs/zh-CN/**` unless explicitly requested.
