# Mission 10 — Update-Issue Classification Receipt

## 1. Title

Mission 10 update/runtime drift classification receipt (fork-vs-upstream reconciliation context).

## 2. Scope of investigation

Bounded local evidence review covering:

- fork lineage/divergence (`main` vs `upstream/main`)
- overlap on core runtime/gateway/config files
- upstream feature-equivalence probes
- telemetry dependency checks:
  - in-repo consumer check
  - recent-window active session history check
  - local external-caller check in last 7 days

## 3. VERIFIED

- Local `main` tracks fork `origin`, not upstream release authority.
- Divergence from upstream is large (`69` local-only commits, `2997` upstream-only commits).
- High-risk overlap exists in core runtime/gateway surfaces (notably `src/agents/pi-embedded-runner/run.ts` and gateway-adjacent files).
- Upstream has no direct matches for local custom features `providerConcurrency`, `configureGovernor`, `governorExecute`, `getTelemetrySnapshot`, `telemetry.get`.
- Upstream does have lane queue primitives (`setCommandLaneConcurrency`, `enqueueCommandInLane`) and diagnostics event types (`queue.lane.enqueue/dequeue`, `diagnostic.heartbeat`).
- Custom telemetry surface is historically used (confirmed in local session history with runtime/API call evidence).
- Custom telemetry surface is not an in-repo dependency outside its own implementation/wiring path.
- No local external-caller evidence for `telemetry.get` was found in available local external-facing surfaces for the last 7 days.

## 4. LIKELY

- Provider-lane concurrency and governor/admission control remain primary unique local features requiring active reconciliation decisions.
- Custom telemetry endpoint (`telemetry.get`) is likely de-scopable from core reconciliation if no external callers are identified.
- Session/spawn/rehydrate behavior is largely covered upstream and should default to upstream behavior unless a local requirement is proven.

## 5. UNKNOWN

- Whether off-host or unobserved services still call `telemetry.get`.
- Whether upstream has hidden/indirect equivalents for governor semantics under different naming.
- Exact minimal implementation needed to preserve local provider fairness goals on top of current upstream.

## 6. Feature classification table

| Feature                          | Evidence summary                                                                                                                                                | Classification                                                          | Current scope status                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| provider-lane concurrency        | Local feature present; no direct upstream config/key equivalent (`providerConcurrency`, provider `maxConcurrentRuns` wiring not found upstream as local design) | Rebuild on upstream primitives                                          | Active reconciliation scope                     |
| governor / admission control     | Local `configureGovernor`/`governorExecute` present; no direct upstream equivalent found                                                                        | Rebuild on upstream runtime/gateway flow                                | Active reconciliation scope                     |
| custom telemetry surface         | Historically used; not an in-repo dependency; no local external-caller evidence in last 7 days                                                                  | Candidate de-scope / replace with upstream diagnostics surfaces         | Candidate de-scope (not globally proven unused) |
| session/spawn/rehydrate surfaces | Upstream contains extensive ACP/session/spawn/rehydrate support and tests                                                                                       | Prefer upstream behavior; avoid local re-implementation unless required | Mostly replace with upstream                    |

## 7. Mission 10 planning implication

Mission 10 should stay re-scoped as upstream-first reconciliation planning.
Primary engineering focus should remain:

- provider-lane concurrency
- governor/admission control

Custom telemetry endpoint should be treated as optional/reducible scope unless a concrete live caller is identified.

## 8. One bounded next action

Produce a minimal reconciliation design note that maps:

1. local provider-lane concurrency intent -> upstream lane primitives
2. local governor intent -> upstream request/run admission points
3. explicit non-goal: custom `telemetry.get` endpoint unless a caller is proven.
