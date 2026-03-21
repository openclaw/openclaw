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
- Stage 3A complete enough to pause (startup phases extracted, typed context threaded across early phases, startup failure classification unified across major boundaries)
- Stage 3B complete for this maintainability pass
- Stages 4 to 5 deferred into a separate follow-on initiative

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
- [x] Disable bundled plugin permission repair writes during config validation read paths
- [x] Route daemon status config loading through explicit read-only config loads
- [x] Isolate daemon status config reads from direct `process.env` object mutation paths
- [x] Hydrate dotenv into read-only env snapshots instead of mutating `process.env` in top-level read helpers

### Stage 2B: global state registry hardening

- [x] Introduce first `RuntimeStateContainer` seam in `runtime-overrides`
- [x] Introduce `RuntimeStateContainer` in startup path
- [x] Keep compatibility adapters for existing globals
- [x] Add tests for container lifecycle and order
- [x] Move fallback gateway context ownership into `RuntimeStateContainer` and clear it during shutdown
- [x] Clear remote skills cache/registry state and health broadcast callback during gateway shutdown
- [x] Clear gateway health cache and ignore stale in-flight refresh writes after shutdown resets

### Stage 3A: gateway startup decomposition

- [x] Extract startup config preflight phase
- [x] Extract startup secrets precheck phase
- [x] Extract startup auth bootstrap phase
- [x] Extract startup runtime policy phase
- [x] Extract control UI root resolution phase
- [x] Extract secrets activation controller seam
- [x] Extract runtime config reloader wiring seam
- [x] Pass typed context phase to phase (preflight, secrets precheck, auth bootstrap, runtime policy)
- [x] Add phase failure classification tests and shared reporting (CLI startup and restart loop)
- [x] Extract explicit runtime-config and control-ui-root startup phase helpers with focused tests
- [x] Classify runtime-config and control-ui-root phase failures through shared startup phase formatter
- [x] Classify secrets precheck, auth bootstrap, and runtime policy startup failures through shared startup phase formatter
- [x] Classify plugin bootstrap startup failures through shared startup phase formatter
- [x] Classify TLS runtime resolution startup failures through shared startup phase formatter
- [x] Classify transport bootstrap startup failures through shared startup phase formatter
- [x] Classify sidecar startup failures through shared startup phase formatter
- [x] Classify discovery startup failures through shared startup phase formatter
- [x] Classify Tailscale exposure startup failures through shared startup phase formatter

### Stage 3B: onboarding flow consolidation

- [x] Extract first shared gateway reachability and health-check workflow used by wizard and non-interactive local onboarding
- [x] Extract shared workspace resolution and workspace-config helpers used by wizard and non-interactive local onboarding
- [x] Extract shared gateway mode probe summary used by configure and setup flows
- [x] Extract shared gateway exposure safety normalization used by wizard and non-interactive local onboarding
- [x] Reuse shared gateway exposure safety normalization in `configure.gateway`
- [x] Thread a shared `LocalSetupIntent` and execution-plan seam through wizard and non-interactive local setup
- [x] Extract shared `LocalGatewaySetupState` used by wizard and non-interactive local onboarding
- [x] Derive shared local gateway reachability inputs from `LocalGatewaySetupState`
- [x] Define shared `OnboardingPlan` decision graph
- [x] Keep separate interactive and non-interactive executors
- [x] Add parity coverage for equivalent inputs

### Stage 4: routing and plugin boundary cleanup

- [ ] Extract route index matcher cache boundaries
- [ ] Narrow plugin runtime surface with capability facades
- [ ] Preserve external behavior parity

### Stage 5: guardrails and enforceability

- [ ] Add checks to block implicit config writes on read paths
- [ ] Add checks to block duplicate preflight path drift
- [ ] Add checks around unapproved `process.env` mutation paths

## Notes

- This maintainability pass ends at Stage 3B. Stages 4 and 5 are intentionally deferred into a separate follow-on initiative.
- `src/wizard/setup.finalize.test.ts` still shows pre-existing sticky runner shutdown behavior in this environment. Track that as a separate follow-up, and fix it before the next substantial change to `src/wizard/setup.finalize.ts`.
- Keep runtime-worktree isolation strict.
- If unrelated changes appear, work around them. Do not revert other contributors.
- Do not touch `docs/zh-CN/**` unless explicitly requested.
