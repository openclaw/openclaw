# Mission 10 — Minimal Reconciliation Design Note

## 1. Title

Mission 10 minimal reconciliation design note for remaining unique features.

## 2. Scope

Strict scope (only):

- provider-lane concurrency
- governor / admission control

Prior source of truth: `M10__ACP_FOUNDATION_FREEZE__2026-03-13/M10_update_issue_receipt.md`.

## 3. VERIFIED

- Upstream has lane queue primitives (`setCommandLaneConcurrency`, `enqueueCommandInLane`) and existing lane configuration points for `cron`, `main`, and `subagent`.
- Upstream does not expose direct equivalents by name for local provider-specific concurrency keys (`providerConcurrency`, provider-level `maxConcurrentRuns` as used locally for lane wiring).
- Upstream does not expose direct equivalents by name for local governor surfaces (`configureGovernor`, `governorExecute`).
- Local fork has existing implementations for both features in gateway/runtime-adjacent files (as previously documented in the update receipt).

## 4. LIKELY

- Provider-lane concurrency can be mapped narrowly onto upstream lane primitives by adding provider-lane derivation/config wiring at lane-setup points.
- Governor intent can be mapped narrowly by wrapping selected high-risk execution entry points (request/run admission points) rather than broad runtime redesign.
- Both features should be treated as targeted overlays on upstream behavior, not replacements for upstream session/spawn/runtime semantics.

## 5. UNKNOWN

- Whether upstream has latent/indirect admission-control controls that already satisfy governor goals without custom logic.
- Minimal safe insertion points for governor controls that preserve upstream behavior under load and restart/retry conditions.
- Whether provider fairness goals require static config only, dynamic adaptation, or both.

## 6. Upstream primitives already available

- Command lane queue API:
  - lane enqueue primitive
  - lane concurrency setter
- Existing gateway lane setup/reload flow for built-in lanes (`cron`, `main`, `subagent`)
- Existing runtime/session queue behavior that should remain authoritative unless a concrete gap is proven

## 7. Mapping note

### provider-lane concurrency

- Mapping target: add provider-derived lanes using existing lane primitives.
- Narrow rebuild shape: configuration-to-lane mapping only (provider key normalization + concurrency assignment).
- Mapping status: partial (primitives exist; direct upstream config surface for this feature is not confirmed).

### governor / admission control

- Mapping target: enforce bounded admission at explicit request/run entry points.
- Narrow rebuild shape: wrapper/guard around selected execution paths, with fail-closed behavior and minimal coupling.
- Mapping status: partial-to-unknown (no direct upstream equivalent found; insertion points require focused validation).

## 8. Rebuild vs defer recommendation

- Rebuild narrowly now:
  - provider-lane concurrency mapping onto upstream lane primitives
  - minimal governor admission wrapper at one or two explicit entry points
- Defer:
  - broader runtime orchestration changes
  - any redesign outside these two features
- Keep unknown pending evidence:
  - dynamic auto-tuning/governor sophistication beyond fixed bounded controls

## 9. Mission 10 implication

Mission 10 should proceed with a constrained implementation-planning lane:

- retain upstream runtime/session/spawn semantics as baseline
- reintroduce only the two unique features with minimal surface area
- treat all additional behavior as out-of-scope until these mappings are validated

## 10. One bounded next action

Author a file-level insertion-point checklist (no code changes) that names exact upstream files/functions where:

1. provider-lane concurrency mapping would be attached
2. governor admission guard would be attached
3. each point’s rollback/removal path is explicitly documented.
