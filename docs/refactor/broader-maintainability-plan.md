---
summary: "Concrete staged plan to reduce hidden state and make startup and runtime behavior predictable"
read_when:
  - Planning maintainability work across runtime and architecture seams
  - Coordinating safe staged refactors with runtime worktree isolation
title: "Broader Maintainability Refactor Plan"
---

# Broader maintainability refactor plan

## Summary

- Focus: make behavior predictable, reduce hidden state, and make debugging paths obvious without a rewrite.
- Strategy: run two tracks in parallel per stage: runtime operational hardening plus architectural seam carving.
- Scope: analysis, design, and small safe cleanup only.

## Scope guard

Do not touch active runtime worktree files in this branch:

- `extensions/telegram/src/bot-native-commands.ts`
- `extensions/telegram/src/bot-native-commands.test.ts`
- `src/auto-reply/commands-registry.data.ts`
- `src/auto-reply/commands-registry.test.ts`
- Telegram live test scripts under `scripts/telegram-e2e/*`
- `scripts/telegram-live-preflight.sh`

## Problem map

### Runtime operational problems

1. Startup path is side-effect heavy and hard to predict (`src/gateway/server.impl.ts`, `src/cli/gateway-cli/run.ts`).
2. CLI and service status can diverge on config and state path resolution (`src/cli/daemon-cli/status.gather.ts`, `src/cli/daemon-cli/status.print.ts`).
3. Config and state path resolution has many precedence branches and legacy fallbacks (`src/config/paths.ts`).
4. Preflight logic is duplicated between route-first and Commander paths (`src/cli/route.ts`, `src/cli/program/preaction.ts`).

### Broader architecture maintainability problems

1. Hidden mutable globals and process-wide caches obscure control flow (`src/globals.ts`, `src/config/runtime-overrides.ts`, `src/config/io.ts`, `src/plugins/runtime.ts`, `src/plugins/hook-runner-global.ts`).
2. God modules concentrate responsibilities (`src/config/io.ts`, `src/gateway/server.impl.ts`, `src/routing/resolve-route.ts`).
3. Onboarding flows duplicate decision and validation logic across interactive and non-interactive commands.
4. Plugin runtime surface is broad and tightly coupled (`src/plugins/runtime/types-channel.ts`).

## Staged execution plan

| Stage | Problem area                        | Why it hurts                                                          | Target state                                                                               | Risk           | Execution style           |
| ----- | ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------- | ------------------------- |
| 0     | Plan and ownership guardrails       | Overlap and unclear ownership causes churn                            | Plan and tracker in `docs/refactor`, explicit do-not-touch runtime slice list              | Low            | Incremental               |
| 1A    | CLI preflight unification           | Route-first and Commander drift in banner, config guard, plugin setup | One shared `prepareCliExecution()` pipeline for both paths                                 | Medium         | Incremental               |
| 1B    | Runtime identity diagnostics        | Wrong runtime and config mismatches are expensive to trace            | Standard runtime fingerprint fields in startup and status output                           | Low            | Incremental               |
| 2A    | Config read and write determinism   | Config load can implicitly mutate state and depend on call order      | Pure read and validate path, explicit mutation and migration APIs                          | Medium         | Incremental then redesign |
| 2B    | Global state registry hardening     | Module globals hide flow and ordering assumptions                     | `RuntimeStateContainer` passed through startup with compatibility adapters                 | Medium         | Incremental               |
| 3A    | Gateway startup decomposition       | Startup orchestrator mixes too many concerns                          | Deterministic phases with typed context handoff                                            | High           | Deeper redesign           |
| 3B    | Onboarding flow consolidation       | Duplicate validation and health logic across flows                    | Shared `OnboardingPlan` graph plus separate executors                                      | Medium         | Incremental then redesign |
| 4     | Routing and plugin boundary cleanup | Route cache and plugin runtime boundaries are hard to reason about    | Split route index matcher cache modules and capability-oriented plugin facades             | Medium to high | Deeper redesign           |
| 5     | Guardrails and enforceability       | Hidden state regressions return silently                              | Architecture tests and lint rules for env mutation, preflight duplication, implicit writes | Medium         | Incremental               |

## Internal contracts to introduce

- `prepareCliExecution(context)` as the single CLI preflight path used by route-first and Commander preAction.
- `RuntimeStateContainer` as the startup state carrier replacing ad hoc globals.
- `OnboardingPlan` interface: intent to validated steps to executor.
- Routing internal cache APIs: `buildRouteIndex` and `resolveRouteFromIndex`.

No user-facing CLI flag removals in stages 1 to 3.

## Acceptance scenarios

1. CLI parity tests: route-first and Commander produce equivalent preflight behavior on `status`, `health`, `config get`, and `models status`.
2. Config determinism tests: config reads do not write files; writes only happen via explicit write or migration APIs.
3. Startup phase tests: each phase fails independently with explicit error classification and no hidden partial mutation.
4. Onboarding parity tests: interactive and non-interactive flows produce equivalent config given equal inputs.
5. Routing cache tests: cache invalidation is correct when bindings, agents, or session references change; fallback behavior is preserved.
6. Operational diagnostics tests: status output includes enough runtime and config identity to explain mismatches directly.

## Branch deliverables

- `docs/refactor/broader-maintainability-plan.md`
- `docs/refactor/broader-maintainability-tracker.md`
- Optional small safe cleanups that do not overlap runtime worktree files.

## Current progress in this branch

- Stage 0: complete.
- Stage 1A: complete with shared preflight helper used by route-first and Commander hooks.
- Stage 1B: complete with runtime fingerprint diagnostics integrated into startup and status paths.
- Stage 2A: complete with deterministic read and mutation seam splits in config paths, including no-repair plugin validation reads to avoid discovery-side chmod writes during config validation, read-only daemon status config loads, daemon status env-isolated read contexts, and dotenv hydration into read-only env snapshots instead of `process.env`.
- Stage 2B: complete with `RuntimeStateContainer` seams threaded through startup/runtime overrides, including fallback gateway context lifecycle ownership, remote skills state cleanup, and gateway health runtime-state reset hardening (cache reset plus stale in-flight refresh guard) during shutdown.
- Stage 3A: complete enough to pause with startup phase extractions for config preflight, secrets precheck, auth bootstrap, runtime policy, explicit runtime-config and control-ui-root helpers, plugin bootstrap, TLS runtime, transport bootstrap, sidecar startup, discovery startup, and Tailscale exposure classification seams, secrets activation controller, and runtime config reloader wiring; early-phase typed startup context handoff and shared startup phase failure reporting now includes secrets-precheck/auth-bootstrap/runtime-policy/plugin-bootstrap/tls-runtime/transport-bootstrap/sidecar-startup/discovery-startup/tailscale-exposure/runtime-config/control-ui-root classification.
- Stage 3B: complete for this maintainability pass with a shared gateway reachability and health-check workflow, a shared workspace resolution and workspace-config seam, a shared gateway mode probe summary, shared gateway exposure safety normalization reused across onboarding and configure flows, a shared `LocalSetupIntent` plus execution-plan seam so wizard and non-interactive local setup stop re-deriving daemon and health expectations inline, a shared `LocalGatewaySetupState` plus reachability-plan seam so both flows carry the same local gateway facts and health inputs, and a shared `OnboardingPlan` decision graph that keeps section/finalize decisions centralized while preserving separate interactive and non-interactive executors.
- Stages 4 to 5: not started.

## Highest leverage next steps after this pass

1. Start a separate Stage 4 initiative for route index, matcher, and cache boundary extraction.
2. Start a separate Stage 4 initiative for plugin runtime capability facades so plugin startup and routing surfaces stop sharing broad ambient state.
3. Start a separate Stage 5 initiative for architectural guardrails that prevent implicit config writes, duplicate preflight drift, and unapproved `process.env` mutation from creeping back in.

## Finish line for this pass

- Finish Stage 3B in this maintainability pass.
- Treat Stages 4 and 5 as a separate follow-on initiative, not part of the same endless refactor branch.
- Reason: Stage 3B still attacks the original fork pain directly: hidden onboarding decisions and overlapping flows. Stages 4 and 5 are broader architecture work and should be re-scoped separately once Stage 3B has a clean stopping point.

## Verification note

This branch keeps runtime-worktree isolation and does not touch protected Telegram runtime files.
`src/wizard/setup.finalize.test.ts` still has pre-existing sticky runner shutdown behavior in this environment, so that test-runner investigation is explicitly deferred as a separate follow-up instead of keeping this maintainability pass open.
