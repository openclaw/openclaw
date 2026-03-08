# SRE Bot "Deep Signals" — Smarter, Context-Aware On-Call Agent

**Date:** 2026-03-02
**Revised:** 2026-03-02 (v34 — Codex adversarial review round 14: fixed outbox `rca_version` race with compare-and-set invariant, aligned Linear pseudocode with attempt-before-call state machine, made `unknown` canonical-category fallback explicit in taxonomy/schema, unified dual-mode downgrade/recovery windows with explicit runtime mode state, fixed residual `non_primary_streak` wording drift, corrected Phase 5 forced-staleness trigger summary, and added regression tests for outbox version race + forced telemetry-gap stale timeout)
**Status:** Approved
**Approach:** Deep Signals (expand evidence pipeline + LLM synthesis + incident memory + optional dual-model RCA)

## Context

The Morpho SRE bot runs as an OpenClaw agent in EKS (monitoring namespace). It performs heartbeat-driven cluster health monitoring every 30 minutes using a 7-step evidence pipeline, routes alerts to Slack by severity, and can create auto-fix PRs when confidence is high.

**Current capabilities:** pod state, K8s events, firing Prometheus alerts, log signals, image-to-repo mapping, commit resolution, CI status, heuristic-scored hypotheses.

**Problem:** The bot diagnoses well within its current signal set, but misses slow-burn issues (resource creep, cert expiry, config drift), has no memory of past incidents, and uses heuristic scoring instead of LLM reasoning for root cause analysis.

## Goal

Make the bot smarter and more context-aware so it functions as a capable read-only on-call SRE assistant. No cluster mutations — focus on better diagnosis, broader observability, and learning from history.

## Product Decisions

- Core incident mode: read-only.
- PR mode: optional, explicitly enabled, create-PR only (never auto-merge/deploy).
- RCA mode: single-model **Codex** synthesis by default; dual-LLM (Codex + Claude) as a measured upgrade gated behind statistical validation (see Phase 6b activation criteria). **Claude scope:** invoked only during active incident investigations in dual mode — both evidence analysis and RCA synthesis. All non-incident LLM tasks (thread archival, daily reports, pattern detection, summarization) always use Codex, regardless of `RCA_MODE`.
- Slack updates: one authoritative RCA per incident with explicit versioning; state changes + 30m digest cadence.

## Constraints

- Stay read-only (no cluster mutations)
- Dev cluster only (morpho-dev namespace, monitoring namespace)
- Linear tickets as incident knowledge base
- Each phase independently shippable (with noted prerequisites: Phase 1 introduces PVC state infrastructure, spool directory, flock patterns, and per-step timeout framework that later phases reuse — these are Phase 1 deliverables, not cross-phase dependencies. Phases 2-4 can ship in any order after Phase 1. Phase 5 depends on Phase 1's PVC infrastructure. Phase 6a depends on Phase 5's incident identity. Phase 6b depends on Phase 6a's measurement data. Phase 7-8 can ship after Phase 5.)

---

## Design

### Expanded Evidence Pipeline (7 → 12 steps, numbered 0–11)

```
Step 0:  Linear Incident Memory Lookup        (NEW — pre-triage)
Step 1:  Pod & Deploy State                    (existing)
Step 2:  K8s Events & Prometheus Alerts        (existing)
Step 3:  Prometheus Metric Trends              (NEW)
Step 4:  ArgoCD Sync & Drift State             (NEW)
Step 5:  Runtime Log Signals                   (existing)
Step 6:  Cert & Secret Health                  (NEW)
Step 7:  AWS Resource Signals                  (NEW — runtime-impacting only)
Step 8:  Image-to-Repo Map                     (existing)
Step 9:  Deployed Revisions                    (existing)
Step 10: CI/CD Signals                         (existing)
Step 11: LLM-Synthesized RCA                   (primary path replaces heuristic; heuristic retained as fallback)
```

### Incident Identity

Every incident needs a stable identity that survives signal drift during the same outage. The bot uses a two-layer identity model:

**Primary key — `incident_id`:** Derived from the stable source of the incident, not from volatile signal content.

- BetterStack-triggered incidents: `bs:{betterstack_incident_id}` (e.g., `bs:12345678`). If BetterStack incident ID extraction fails (parsing error, missing field), fall back to `bs:thread:{slack_thread_ts}` using the Slack thread timestamp as a stable proxy. Log `incident_id_source=bs_thread_fallback` for tracking.
- Heartbeat-detected incidents: `hb:{namespace}:{primary_category}:{first_seen_ts}:{workload_hash8}` (e.g., `hb:morpho-dev:resource_exhaustion:20260302T1430:a3f19bc2`). The `primary_category` is produced by the heuristic pre-LLM classifier on the first triage pass — it maps the highest-scoring signal category to one of 8 canonical values (plus `unknown` — see below). The `first_seen_ts` is the compact UTC timestamp of the first heartbeat that detected this incident (format: `YYYYMMDDTHHMM` — no trailing `Z`, UTC is implied by convention; all timestamps in the state file are UTC). The `workload_hash8` is the first 8 hex chars of SHA-256 of the sorted affected pod prefixes (deployment/statefulset names) at first detection — this disambiguates two same-category incidents first seen in the same minute but affecting different workloads. **Empty workload set:** If no pod prefixes are discoverable at first detection (all pods terminated, namespace-level event), use the fixed sentinel `empty000` as `workload_hash8`. This is out-of-domain (contains non-hex character `y`) so it cannot collide with any real SHA-256 prefix. Two empty-workload incidents with the same category in the same minute will collide — this is acceptable because: (a) empty workloads means we cannot distinguish them anyway, (b) collision merges into one ticket (over-grouping), the safer failure mode. **Monitoring guard:** Emit `incident_id_empty_workload` counter each time the sentinel is used. If count exceeds 3 in a 24h window, post alert to `#staging-infra-monitoring`: `{n} incidents created with empty workloads in 24h — investigate pod discovery pipeline.` Frequent empty-workload incidents suggest a broken workload discovery step, not normal operation. **Ambiguous-empty monitoring guard:** Emit `incident_id_ambiguous_empty_workload` counter each time the ambiguous-empty routing path fires (see Multi-incident routing tier 2). If count exceeds 5 in a 24h window, post alert to `#staging-infra-monitoring`: `{n} ambiguous-empty routing events in 24h — pod discovery may be persistently broken for one or more namespaces.` Together these form a stable ID that does not rotate on hour boundaries and does not collide on same-minute same-category detection when workloads differ. **Same-workload collision acknowledgment:** Two genuinely distinct incidents with the same category, same minute, and the same affected workloads will produce identical `incident_id`s and merge into a single incident. This is by design — identical category + identical workloads + same time window strongly implies the same root cause (or at minimum the same blast radius), making merge the correct behavior. If two truly independent failures happen to affect the same pods with the same failure mode in the same minute, the merged incident will contain signals from both, and the RCA will surface both hypotheses. The on-call can split manually if needed. This is strictly better than the alternative (adding a random suffix) which would create churn and defeat dedup.
- If the heuristic classifier cannot confidently map to any of the canonical categories (all signal scores tied or below 10 points), use `unknown` as the `primary_category`. The `workload_hash8` suffix in the ID (present on all heartbeat IDs) still disambiguates unrelated `unknown` incidents affecting different workloads. Example: `hb:morpho-dev:unknown:20260302T1430:a3f19bc2`. Two simultaneous `unknown` incidents affecting different workloads get distinct IDs via the hash; two affecting the same workloads still merge (acceptable — same blast radius implies related). **RCA handling of `unknown`-ID incidents:** When Step 11 receives an incident with `primary_category=unknown` (from the heuristic pre-classifier), the LLM first attempts to classify into one of the 8 named categories. If classification remains uncertain, it emits `canonical_category: unknown` (explicit fallback category in the taxonomy/output schema). `unknown` in RCA output triggers mandatory `[NEEDS REVIEW]` flag, hard-blocks the PR lane, and is excluded from pattern detection aggregation (to prevent false pattern matches on unclassified incidents). Downstream consumers (label selection, validators, pattern detection) must accept 9 values (8 named + `unknown`).
- Metric: `incident_id_source` logged per incident (`bs_api`, `bs_thread_fallback`, `hb_persistent`) for tracking identity quality.
- **BetterStack ↔ heartbeat reconciliation:** A single outage may trigger both a BetterStack alert (`bs:{id}`) and a heartbeat detection (`hb:{...}`) within the same time window. These create separate incident rows with different `incident_id` prefixes. **Merge rule:** When a heartbeat-detected incident is being created (new `incident_id`), check if an active `bs:*` incident exists for the same namespace with `last_seen_ts` within 30 minutes and overlapping workloads (same rules as exact match — `|intersection| >= 1` shared pod prefix when both non-empty, skip when either empty). If a match is found, do **not** create a new `hb:*` incident — instead, route to the existing `bs:*` incident (it has priority as the externally-sourced identity). The heartbeat's evidence is merged into the BetterStack incident's RCA. If no match, create the `hb:*` incident normally. The reverse (BetterStack alert arriving after heartbeat created the `hb:*` row) is handled symmetrically: before creating a `bs:*` row, check for an active `hb:*` match. If found, alias: write the `bs:{id}` as a metadata annotation on the existing `hb:*` row using the dedicated `bs_alias` column (see state file schema). The `category_drift_log` is reserved exclusively for `ts:new_category` entries — BetterStack alias annotations must not be stored there. Route the BetterStack alert's Slack thread to the existing incident. **Dual-thread reconciliation:** If the `hb:*` incident already has a Slack thread (populated `slack_thread_ts`), the BetterStack alert's thread becomes a secondary reference — post a cross-link message in both threads: `Linked to BetterStack alert thread: {bs_thread_link}` in the heartbeat thread, and `Linked to incident thread: {hb_thread_link}` in the BetterStack thread. Subsequent RCA updates post only to the heartbeat thread (primary). If the `hb:*` incident has no Slack thread yet, adopt the BetterStack alert's thread as the incident's `slack_thread_ts`. This prevents one outage from producing two tickets/threads. If both arrive simultaneously (race), the flock serializes with **first-writer-wins** precedence: the first writer (whichever acquires the flock) creates its row with its identity prefix (`bs:*` or `hb:*`); the second writer, upon acquiring the flock, sees the existing row, finds a match, and aliases into it rather than creating a duplicate. The resulting identity prefix is therefore determined by flock acquisition order, not by source type. This is acceptable because alias reconciliation is symmetric — a `bs:*` primary with `hb:*` alias and an `hb:*` primary with `bs_alias` annotation both produce the same operational outcome (single incident, single thread, merged evidence).

**Incident state persistence:**

Incident identity must survive pod restarts, hour boundaries, and signal drift. The bot maintains a persistent state file on PVC-backed storage:

**State file:** `${INCIDENT_STATE_DIR}/active-incidents.tsv` (same PVC as existing `incident-gate.tsv`)

**TSV encoding contract:**

- **Column delimiter:** TAB (`\t`). Columns must never contain literal TAB characters.
- **Intra-field delimiters:** `|` (pipe) for `affected_workloads` and `evidence_signal_keys`; `,` (comma) for `category_drift_log` entries. These characters are forbidden in the atomic values they separate (pod prefixes, signal keys, category names — all restricted to `[a-zA-Z0-9_:.-]`).
- **Escaping:** No escaping needed given the character restrictions above. Implementations must validate **atomic values** (individual pod prefixes, signal keys, category names) against `[a-zA-Z0-9_:.\-]` — note this regex deliberately **excludes** `|` and `,` which are reserved as intra-field delimiters. The full field value (after joining with delimiter) is validated against `[a-zA-Z0-9_:.\-|,]`. Reject/sanitize non-conforming atomic values on write. **Validation scope:** Validation applies only to **known columns** (those listed in the current schema). Unrecognized columns (from a newer schema version) are preserved byte-for-byte on rewrite without validation — the writer cannot know their encoding contract.
- **Schema version:** First line of the file is a header comment: `#v1\t{column_names}`. Schema migrations increment the version number. Reader implementations support a **backward-compatible window of 2 versions** (e.g., a v2 reader can read v1 and v2 files). On encountering an unknown version > current+1 (skipped version), log a warning and degrade gracefully — **preserve unrecognized columns byte-for-byte on rewrite** (read all columns, only modify known columns, write all columns back including unknown ones). This prevents an older binary from silently dropping newer columns (e.g., outbox fields) during a rolling deploy. On encountering a completely unrecognizable format (no version header, corrupt), **quarantine and rebuild:** (1) Rename the corrupt file to `active-incidents.tsv.corrupt.{timestamp}` (preserves evidence for debugging). (2) Start with an empty state file (new header, zero rows). (3) Post alert to `#staging-infra-monitoring`: `State file corrupted — quarantined to {filename}. Starting fresh. Active incidents will be re-detected on next unhealthy heartbeat. Previously tracked incidents may receive duplicate Linear tickets (the Linear API search fallback will attempt dedup).` (4) On the next heartbeat, any still-active incidents will be re-detected as new (new `incident_id`, new `first_seen_ts`). The Linear ticket creation path's fallback search (search for `incident_id` in ticket description) will not match the old ID — but the pattern detection search (match on `canonical_category` + namespace + services from last 30 days) will surface the prior ticket as a "similar incident," giving the on-call context. This is an acceptable trade-off: a brief identity discontinuity is far better than a persistent crash loop that blocks all triage.

| Column                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incident_id`          | Stable primary key (e.g., `hb:morpho-dev:resource_exhaustion:20260302T1430:a3f19bc2`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `namespace`            | Monitored namespace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `primary_category`     | Locked category from first detection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `first_seen_ts`        | UTC timestamp of first detection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `last_seen_ts`         | UTC timestamp of most recent unhealthy heartbeat that matched this incident (any match — primary or keep-alive, regardless of workload availability). Used for continuity matcher staleness bounds (120m exact, 60m drift) and the 240m forced stale-timeout silence trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `last_nonempty_ts`     | UTC timestamp of most recent unhealthy heartbeat that matched this incident AND had non-empty workloads. Used for stale auto-resolve timers: 120m standard timeout and 240m forced timeout trigger (telemetry-gap guard). Only updated when the heartbeat's workload list is non-empty. Equals `last_seen_ts` when workloads are available; lags behind during telemetry gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rca_version`          | Current RCA version number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `evidence_fingerprint` | SHA-256 hash of the **full sorted signal key set** (all keys emitted by Steps 1-10, not just the stored top-20 subset). This ensures the fingerprint detects evidence changes even when new keys fall outside the stored 20-key window. The stored `evidence_signal_keys` (top-20) is a display/matching subset; the fingerprint covers the complete evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `evidence_signal_keys` | Pipe-separated list of signal keys from latest triage, sorted lexicographically, capped at 20 keys (e.g., `step01:crashloop_redis\|step02:oom_event\|step03:memory_creep`). **Key format:** Step numbers are **zero-padded to 2 digits** (`step01`..`step11`) so that lexicographic sort equals numeric step order (`step01` < `step02` < ... < `step10` < `step11`). Without zero-padding, `step10` would sort before `step2`, causing inconsistent fingerprints across implementations. **Key selection:** Each step emits 0-N signal keys in `step{NN}:{signal_name}` format (NN = zero-padded step number). All emitted keys are collected, sorted lexicographically, and truncated to the first 20. Deterministic selection ensures the same evidence produces the same key set across concurrent runs. Stored for continuity matching overlap computation only. **Not used for fingerprint generation** — `evidence_fingerprint` is computed from the full key set at triage time (see `evidence_fingerprint` column), not from the stored top-20 subset. |
| `linear_ticket_id`     | Linear ticket ID (if created), empty otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `slack_thread_ts`      | Slack thread timestamp (if posted), empty otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `affected_workloads`   | Pipe-separated list of pod prefixes (e.g., `api-server\|redis-cache\|worker`) — updated only when the current heartbeat's workload list is non-empty (see Workload update invariant)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `category_drift_log`   | Append-only log of category changes: `20260302T1445:config_drift,20260302T1500:resource_exhaustion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `slack_post_status`    | Outbox status for Slack writes: `pending\|sent\|failed_retryable\|failed_terminal` (see Outbox pattern below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `slack_post_attempts`  | Integer: number of Slack post attempts so far (0 on new row, incremented on each POST attempt including the initial send)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `linear_post_status`   | Outbox status for Linear writes: `pending\|sent\|failed_retryable\|failed_terminal` (see Outbox pattern below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `linear_post_attempts` | Integer: number of Linear post attempts so far (0 on new row, incremented on each POST attempt including the initial send)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `linear_reservation`   | Reservation marker for two-phase ticket creation: empty (no reservation), `pending:{epoch_seconds}` (creation in-progress, where `{epoch_seconds}` is Unix epoch seconds as a decimal integer, e.g., `pending:1709395200`). Separate from `linear_ticket_id` to avoid overloading that field with non-ID values. Cleared on API success (ticket ID written to `linear_ticket_id`) or API failure. Stale reservations (>120s age based on epoch comparison) are reclaimed by the next writer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bs_alias`             | BetterStack alias annotation: empty (no alias), or `bs:{betterstack_incident_id}` when a BetterStack alert was correlated with this heartbeat-detected incident (see BetterStack ↔ heartbeat reconciliation). Stored separately from `category_drift_log` which is reserved exclusively for `ts:new_category` entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `last_primary_ts`      | UTC timestamp of most recent heartbeat where this incident was the **primary routing target** (full RCA processing). Used by resolution branch (b) to determine if the incident has not been primary for 2+ consecutive heartbeats. Updated only on primary routing — keep-alive touches do NOT update this field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `non_primary_streak`   | Integer counter: number of consecutive heartbeats where this incident was NOT the primary routing target — incremented on **every** heartbeat that processes this namespace (regardless of whether the incident received a keep-alive touch). Reset to 0 when this incident IS the primary routing target. Used by resolution branch (b): when `non_primary_streak >= 2` AND the incident's workloads no longer overlap with current heartbeat's workloads (with non-empty workloads), the incident is eligible for resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Lifecycle:**

1. **New incident detected** (unhealthy heartbeat, no match via continuity matcher — see below): Generate `incident_id` with current timestamp as `first_seen_ts`. Write new row to state file.
2. **Ongoing incident** (unhealthy heartbeat, matched via continuity matcher): Reuse `incident_id` from state file. Update `last_seen_ts`, `evidence_signal_keys`, and `evidence_fingerprint`. Bump `rca_version` if fingerprint changed. If category drifted, append to `category_drift_log`. The `evidence_signal_keys` refresh is critical — stale keys would cause the continuity matcher to under-count overlap on the next heartbeat, potentially forking the same incident.
   - **Heartbeat fan-out (multi-incident keep-alive):** A single heartbeat may contain signals relevant to multiple active incidents (e.g., `resource_exhaustion` on `api-server` AND `config_drift` on `worker` in the same namespace). The routing step (see Multi-incident routing) selects the **primary** incident for full RCA processing. Additionally, **all other active incidents** whose workloads overlap with the current heartbeat's workload list receive a `last_seen_ts` touch (keep-alive) even though they are not the primary routing target. This prevents non-primary incidents from stale-timing out while the outage is still active. The keep-alive touch updates `last_seen_ts` (always) and `last_nonempty_ts` (only if the current heartbeat's workload list is non-empty), and if the current heartbeat's workload list is non-empty, refreshes `affected_workloads` on the non-primary incident (subject to the workload update invariant — empty snapshots never overwrite). Signal keys (`evidence_signal_keys`) are **not** refreshed on keep-alive — only the primary incident receives a full evidence refresh. This is a deliberate trade-off: workload overlap is critical for routing accuracy (stale workloads could cause a non-primary incident to fail exact-match on the next heartbeat and fork), while signal keys are only used by the continuity matcher's drift tier (which already compensates for staleness with threshold adjustments). No RCA bump, no Slack post. If no workload overlap exists (disjoint incidents), the non-primary incident receives no touch and may stale-timeout as designed.
   - **Workload update invariant:** `affected_workloads` is updated only when the current heartbeat's workload list is **non-empty**. An empty snapshot (transient pod-discovery failure) never overwrites a populated set. This ensures that a momentary discovery gap does not erase the workload data needed for dedup on subsequent heartbeats.
3. **Incident resolved** — resolution is **per-incident**, not namespace-global. An active incident is resolved when: (a) a healthy heartbeat is received for the namespace AND no signals matching the incident's category/workloads are present in the current evidence, OR (b) the incident's `non_primary_streak >= 2` (tracked in the state file — incremented on **every non-primary heartbeat for that namespace**, reset on primary routing) AND its workloads no longer overlap with any current unhealthy signals **AND the current heartbeat's workload list is non-empty** (a telemetry gap — empty workloads — does not count as "no overlap"; it counts as "unknown overlap"). This allows multiple incidents in the same namespace to resolve independently — a `resource_exhaustion` incident on `api-server` can resolve while `config_drift` on `worker` remains active. **Telemetry gap guard:** Branch (b) is blocked when the current heartbeat's workloads are empty — the incident stays active until either (a) applies (healthy heartbeat) or workload telemetry recovers and branch (b) can evaluate real overlap. This prevents premature closure during pod-discovery outages. Resolved rows are moved to `resolved-incidents.tsv` archive. **Archive file contract:** The archive file uses an **extended schema** based on `active-incidents.tsv`: all 21 columns from the active schema (same column order, format, and encoding) plus 2 appended columns: `resolution_reason` (string, e.g., `stale_timeout`, `stale_timeout_forced`, `healthy_heartbeat`) and `resolved_ts` (UTC epoch seconds). The version header reflects the extended schema: `#v1-resolved\t{column_names}` (distinct from active file's `#v1` to prevent accidental cross-reads). **Retention:** Rows older than 30 days (by `resolved_ts`) are pruned on each write pass. This bounds archive growth while keeping sufficient history for pattern detection (Step 0 searches Linear, not the archive file — the archive is for local forensics only). The quarantine-and-rebuild logic applies to the archive file identically: corrupt archive is renamed `.corrupt.{timestamp}` and a fresh empty archive is started. Next unhealthy heartbeat matching a resolved incident's fingerprint starts a fresh incident with a new `first_seen_ts`.
   - **Staleness auto-resolve — execution order:** Stale-resolution runs **after** the continuity matcher attempts to match the current heartbeat against active incidents. If an incident is matched by the current heartbeat (primary or keep-alive), its timestamps are updated first; the staleness scan then evaluates the updated timestamps. This prevents a heartbeat from auto-archiving an incident it would have matched, only to recreate it as a new incident (which would produce duplicate Slack threads/Linear tickets). **120m standard timer:** Uses `last_nonempty_ts` (not `last_seen_ts`). Any row with `last_nonempty_ts` older than 120 minutes AND not matched by the current heartbeat is auto-resolved with `resolution_reason: stale_timeout`. During a telemetry gap (empty workloads across all heartbeats), `last_nonempty_ts` is not updated — the 120m timer effectively pauses. When a heartbeat with non-empty workloads arrives, `last_nonempty_ts` is updated (if matched), and the 120m check runs against the fresh value. The `incident_stale_timeout` metric is still emitted (with tag `deferred_telemetry_gap=true` when the 120m would have fired but was deferred due to no non-empty heartbeats) for monitoring. **240m forced resolution — two triggers (either fires):** (a) `now - last_seen_ts > 240m` — no heartbeat of any kind has matched this incident in 240m (complete silence). (b) `now - last_nonempty_ts > 240m` — no heartbeat with non-empty workloads has matched in 240m (sustained telemetry gap with empty-workload keep-alives still advancing `last_seen_ts`). Trigger (b) prevents incidents from living forever during prolonged pod-discovery outages where keep-alive touches keep `last_seen_ts` fresh but provide no real telemetry. Both triggers resolve with `resolution_reason: stale_timeout_forced` and an alert noting the gap type.
   - **External closure on stale timeout:** When a row is stale-resolved (either at the standard 120m threshold with non-empty workloads, or at the 240m forced threshold during a telemetry gap):
     - **Linear ticket:** If `linear_ticket_id` is populated, add a comment: `Incident auto-closed after {elapsed}m without activity ({resolution_reason}). Last seen: {last_seen_ts}. Resolution may require human verification.` The `{elapsed}` and `{resolution_reason}` reflect the actual threshold that triggered closure (`stale_timeout` at 120m or `stale_timeout_forced` at 240m). Do **not** change ticket status — the operator decides whether to close or reopen.
     - **Slack thread:** If `slack_thread_ts` is populated, post: `This incident has been inactive for >{elapsed_hours}h. Auto-archived ({resolution_reason}). If still ongoing, a new triage will create a fresh thread.`
     - **Metrics:** Emit `incident_stale_timeout` counter (namespace, category) for monitoring the health of the heartbeat trigger itself. Frequent stale timeouts indicate trigger reliability issues.
4. **Pod restart recovery:** On startup, read `active-incidents.tsv` from PVC. Resume any active incidents with their locked `incident_id`, `primary_category`, `linear_ticket_id`, and `slack_thread_ts`. No identity discontinuity.

**Matching logic for "same incident" — continuity matcher:**

An incoming unhealthy heartbeat matches an active incident through a two-tier matcher. This prevents a classifier flip (e.g., `resource_exhaustion` → `config_drift` on new evidence) from forking the same outage into two incidents:

1. **Exact match (fast path):** ALL of: `namespace` matches AND `primary_category` matches AND `last_seen_ts` is within 120 minutes of current heartbeat (staleness bound) AND workload overlap passes (see sub-rules below). The 120m staleness bound (2× the 60m heartbeat gap tolerance) prevents a new outage from being silently merged into a stale incident row that was never resolved because a healthy heartbeat was missed (e.g., trigger gap, pod downtime, Slack outage). If `last_seen_ts` is older than 120m, the row fails the exact-match staleness gate and is not eligible for matching. Note: the actual stale auto-resolve (which moves rows to archive) runs **after** matching using `last_nonempty_ts` — see Staleness auto-resolve section. The 120m gate here only prevents matching; it does not archive.
   - **Workload overlap rule:** If both the incident's stored `affected_workloads` AND the current heartbeat's workloads are non-empty: require ≥1 shared pod prefix. Zero overlap (completely disjoint) → not an exact match, fall through to tier 3 evaluation (continuity candidates); if none qualify (e.g., same category — continuity requires different category), tier 4 → new incident.
   - **Either side empty:** If the incident's stored `affected_workloads` is empty OR the current heartbeat's workload list is empty, the workload check is **skipped** — namespace + category + staleness bound alone suffice. **Single-candidate risk acknowledgment:** When exactly one active incident matches via empty-side skip, the heartbeat is routed to it. This can over-merge an unrelated incident during a telemetry gap. This is accepted as the safer failure mode (over-grouping into one ticket vs. creating a new ticket per heartbeat). The `incident_id_empty_workload` monitoring guard (>3 events/24h) alerts operators when empty-workload routing is firing frequently. For the >1 candidates case, see multi-incident routing tier 2. This prevents an incident with no discoverable pods (e.g., all pods terminated, namespace-level event with no running workloads) from forking into a new incident every heartbeat. Per the workload update invariant, stored workloads are only overwritten by non-empty snapshots — a transient discovery failure never erases existing workload data.
   - **Creation race:** If two heartbeats arrive simultaneously for the same category but different workloads, the flock serializes them: the first creates the incident and writes its workloads; the second sees populated workloads and the overlap check applies normally.
2. **Continuity match (drift-tolerant):** `namespace` matches AND `primary_category` differs. The match requires the time window PLUS at least one corroborating dimension (workload or signal key overlap). Empty/non-empty permutations:
   - Workloads both available, signal keys both available: Time ≤60m AND workload Jaccard ≥50% AND signal key Jaccard ≥30%.
   - Workloads either empty, signal keys both available: Time ≤60m AND signal key Jaccard ≥50% (raised from 30%).
   - Workloads both available, signal keys either empty: Time ≤60m AND workload Jaccard ≥70% (raised from 50%).
   - Workloads either empty, signal keys either empty: **No continuity match possible** — fall through to new incident.
   - **Time window:** `last_seen_ts` is within 60 minutes of current heartbeat (same active outage window) — **always required, no exceptions**. **Intentional asymmetry with exact match (120m):** The exact match tier uses a 120m staleness bound because same-category + same-workload overlap provides strong identity evidence — even after a missed heartbeat (60m gap), we can confidently match. The continuity tier uses a stricter 60m bound because category-drift matching is inherently weaker evidence — merging a drifted-category heartbeat after >60m gap is more likely to incorrectly merge a genuinely new incident. If a category drifts after 60m, the incident will fork — this is the safer failure mode (slightly more tickets, but each accurately categorized). The exact match tier will still catch it if the category drifts back within 120m.
   - **Workload overlap:** ≥50% of affected pod prefixes (deployment/statefulset names) overlap with the incident's `affected_workloads` set. **Empty-side exception:** If either side's workload list is empty, the workload overlap check is **skipped** but the signal key overlap threshold is raised to ≥50% (from 30%) to compensate for the missing dimension. This prevents a category drift during a pod-discovery outage from forking the same incident.
   - **Signal key overlap:** ≥30% of current `evidence_signal_keys` overlap with the incident's stored `evidence_signal_keys` (set intersection on the pipe-separated key lists). Raised to ≥50% when workload overlap is skipped due to empty-side exception (see above). **Empty signal keys:** If either side's `evidence_signal_keys` is empty (no signals collected — triage pipeline partially failed), the signal key check is **skipped** but continuity match requires the workload overlap threshold to be raised to ≥70% (from 50%) to compensate. If **both** workloads and signal keys are empty on either side, **continuity match is disabled** — fall through to tier 3 (no match → new incident). Rationale: with no workload or signal data, we have zero evidence that these are the same outage; only a time window and namespace match. Merging would create dangerous over-grouping exactly when observability is weakest (different categories, no corroborating signals). This is the one case where creating a potentially duplicate incident is safer than silently merging. Emit `continuity_match_disabled_no_telemetry` metric for monitoring.
     → reuse incident. **Do not relabel `primary_category`** — the original locked category stays in the `incident_id`. The category drift is recorded in a new state file column `category_drift_log` (append-only list of `ts:new_category` entries) for post-mortem analysis.

3. **No match:** Neither exact nor continuity match → this is a genuinely new incident. Generate new `incident_id`.

**Multi-incident routing (same namespace, multiple active incidents):** When multiple active incidents exist for the same namespace (regardless of category), the incoming heartbeat is routed using this priority order:

1. **Exact match** — highest priority. An incident passes the exact match rule defined above (same category + staleness ≤120m + workload overlap passes, including the empty-side skip). If exactly one active incident matches, route there.
2. **Multiple exact matches** (same category, multiple incidents match — possible with broad workload sets):
   - If the current heartbeat's workload list is **non-empty**: pick the incident with the highest **Jaccard similarity** (`|current ∩ stored| / |current ∪ stored|`), not raw overlap count — this prevents a large broad-workload incident from absorbing unrelated heartbeats that happen to share a few common pods. Tie-break: most recent `last_seen_ts`.
   - If the current heartbeat's workload list is **empty** and >1 candidates matched via empty-side skip: **do not route by recency** — this is an ambiguous match caused by a transient pod-discovery failure. Check whether an `empty000`-sentinel incident already exists for this namespace+category (created by a previous ambiguous-empty heartbeat) and is still active (not stale) **and still ambiguous** (stored `affected_workloads` is still empty — a sentinel incident that has since received a non-empty workload update is no longer ambiguous and must not absorb future empty heartbeats). If a qualifying ambiguous sentinel exists → route to it (prevents churn). If multiple qualifying sentinel rows exist (manual edits, recovery anomalies): pick the one with the most recent `last_seen_ts`; tie-break: lowest `first_seen_ts`. If no qualifying sentinel exists → create one new ambiguous incident with sentinel `empty000` hash. In all cases, emit `incident_id_ambiguous_empty_workload` metric. **Over-merge acknowledgment:** During a sustained pod-discovery outage, this design intentionally over-merges all empty-workload heartbeats of the same category into a single `empty000` sentinel incident — even if they represent genuinely distinct incidents. This is the safer failure mode: over-grouping produces one ticket that covers too much, rather than N duplicate tickets per heartbeat. The `incident_id_ambiguous_empty_workload` monitoring guard (alert at >5 events/24h) ensures operators are notified when this over-merge path is firing frequently, prompting investigation of the discovery pipeline. Once discovery recovers and workloads become non-empty, the sentinel incident's workloads are populated (per the workload update invariant), and subsequent heartbeats with disjoint workloads correctly fork into new incidents (the sentinel is no longer ambiguous — see sentinel recovery disqualification). This limits the damage from sustained discovery outages to at most one extra incident per namespace+category, not one per heartbeat.
3. **No exact match, one or more continuity matches** — score each candidate. **When all dimensions are available:** `score = (workload_overlap × 0.5) + (signal_key_overlap × 0.3) + (time_recency × 0.2)`. **When a dimension is unavailable (empty-side skip):** re-normalize the remaining weights to sum to 1.0. For example, if workloads are empty: `score = (signal_key_overlap × 0.6) + (time_recency × 0.4)` (0.3/(0.3+0.2) and 0.2/(0.3+0.2)). If signal keys are empty: `score = (workload_overlap × 0.71) + (time_recency × 0.29)`. All inputs normalized to 0.0–1.0: `workload_overlap = |current ∩ stored| / |current ∪ stored|` (Jaccard), `signal_key_overlap = |current ∩ stored| / |current ∪ stored|` (Jaccard), `time_recency = max(0, 1 - (minutes_since_last_seen / 60))`. Score range: 0.0–1.0. Highest score wins. Tie-break: lowest `first_seen_ts` (oldest incident absorbs).
4. **No exact match, no continuity match** — new incident.

If the active incident category is `unknown`, it does **not** get special absorption priority — it participates in the standard scoring (workload overlap via the exact match rule, or continuity scoring if categories differ). This prevents an `unknown` incident from silently merging with an unrelated incident that happens to get classified later in the same namespace.

**New state file columns for continuity matching:**

| Column               | Description                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `affected_workloads` | Pipe-separated list of pod prefixes (e.g., `api-server\|redis-cache\|worker`) — updated only when the current heartbeat's workload list is **non-empty** (see Workload update invariant above) |
| `category_drift_log` | Append-only log of category changes: `20260302T1445:config_drift,20260302T1500:resource_exhaustion`                                                                                            |

**Secondary signals — `evidence_fingerprint` + `evidence_signal_keys`:** The fingerprint is the SHA-256 hash of sorted signal keys — used for fast equality check (same hash → same evidence → skip RCA update). The `evidence_signal_keys` are the structured key list stored alongside the hash — used by the continuity matcher to compute overlap when categories differ.

**Role in incident identity:** Signal keys are **never the primary identity** — `incident_id` is always derived from namespace + locked category + first_seen_ts + workload_hash8 (see Primary key definition above). However, signal keys do participate in the continuity matcher's drift-tolerant tier. Similarly, `affected_workloads` participates in the exact match tier: two incidents with the same category but completely disjoint workloads (both non-empty) are not considered the same incident.

**Normative continuity match pseudocode (single canonical definition — all prose descriptions must agree with this):**

```
function continuity_match(heartbeat, incident):
  if incident.namespace != heartbeat.namespace: return NO_MATCH
  if incident.primary_category == heartbeat.category: return NO_MATCH  # same category → exact match tier, not continuity
  if minutes_since(incident.last_seen_ts) > 60: return NO_MATCH  # time gate — always required, no exceptions

  wl_available = (incident.workloads non-empty) AND (heartbeat.workloads non-empty)
  sk_available = (incident.signal_keys non-empty) AND (heartbeat.signal_keys non-empty)

  if NOT wl_available AND NOT sk_available:
    emit("continuity_match_disabled_no_telemetry")
    return NO_MATCH  # zero corroborating evidence — refuse to merge

  wl_ok = True   # assume pass if dimension skipped
  sk_ok = True   # assume pass if dimension skipped

  if wl_available:
    wl_ok = jaccard(incident.workloads, heartbeat.workloads) >= 0.50
  if sk_available:
    sk_threshold = 0.50 if NOT wl_available else 0.30  # raised when workloads missing
    sk_ok = jaccard(incident.signal_keys, heartbeat.signal_keys) >= sk_threshold
  if wl_available AND NOT sk_available:
    wl_ok = jaccard(incident.workloads, heartbeat.workloads) >= 0.70  # raised when signals missing

  return MATCH if (wl_ok AND sk_ok) else NO_MATCH
```

The truth table in the "Continuity match" section above is derived from this pseudocode. The key invariant: time ≤60m is always required; at least one of workloads or signal keys must be available; when one dimension is missing, the other's threshold is raised to compensate.

**Rules:**

- Same `incident_id` → same incident, same Linear ticket, same Slack thread. Update RCA if `evidence_fingerprint` changed.
- Different `incident_id` → different incident. New ticket, new thread.
- Signal drift (pod restarts changing names, new error types appearing, services joining/leaving the impacted set) within the same `incident_id` triggers an RCA version bump, not a new incident.

### Per-Step Timeout Budget

Every step has an explicit timeout. If a step exceeds its timeout, it is skipped and its output section is marked `status: timeout` in the evidence bundle. The pipeline continues with remaining steps.

| Step                 | Timeout                                             | Required | Skip-on-timeout behavior                      |
| -------------------- | --------------------------------------------------- | -------- | --------------------------------------------- |
| 0: Linear lookup     | 5s                                                  | no       | Skip; RCA proceeds without historical context |
| 1: Pod & Deploy      | 8s                                                  | **yes**  | Abort if fails — core signal                  |
| 2: Events & Alerts   | 8s                                                  | **yes**  | Abort if fails — core signal                  |
| 3: Prometheus Trends | 10s                                                 | no       | Skip; trend data absent from evidence         |
| 4: ArgoCD Sync       | 5s                                                  | no       | Skip; sync state absent from evidence         |
| 5: Log Signals       | 10s                                                 | no       | Skip; log snippets absent                     |
| 6: Cert & Secret     | 5s                                                  | no       | Skip; cert data absent                        |
| 7: AWS Resources     | 8s                                                  | no       | Skip; node health absent                      |
| 8: Image-to-Repo     | 5s                                                  | no       | Skip; repo correlation absent                 |
| 9: Revisions         | 5s                                                  | no       | Skip; revision data absent                    |
| 10: CI/CD            | 5s                                                  | no       | Skip; CI status absent                        |
| 11: LLM RCA          | 15s (single) / 45s max (dual, up to 3 rounds × 15s) | no       | Heuristic fallback                            |

**Total worst-case (sequential upper bound):** 89s single / 119s dual — computed as the sum of all per-step timeouts (steps run sequentially, not in parallel). All steps hitting their timeout ceiling simultaneously is a pathological scenario; realistic latencies are far lower. Realistic healthy: ~15-25s. Realistic single-model incident: ~30-50s. Realistic dual-model incident: ~40-75s (converge Round 0-1 in most cases).

### Minimum Evidence Completeness Gate

Before posting an authoritative RCA (Step 11 output), the pipeline checks evidence completeness:

**Required steps (must succeed):** Step 1 (Pod & Deploy) AND Step 2 (Events & Alerts). These are the core K8s signals. If either times out or errors, the pipeline aborts and posts a brief status: `Insufficient evidence — core cluster signals unavailable. Manual investigation required.` No RCA, no PR recommendation. **Incident-state behavior on abort:** If an active incident can be matched with available data, update `last_seen_ts` to current time (incident still active, RCA unavailable this pass). If neither step produced matchable data, apply a conservative fallback keep-alive: for active incidents in the same namespace with `last_seen_ts` within 120m, touch only `last_seen_ts` (do not touch `last_nonempty_ts`). Do not bump `rca_version`, do not update `evidence_fingerprint`, do not touch outbox status. This prevents stale auto-resolve during transient core-signal outages without inventing new evidence. If no active incident qualifies (potential new incident), do not create a state file row — without core signals, we cannot reliably generate an `incident_id` (category classification requires Step 1/2 data). The condition will be re-evaluated on the next heartbeat.

**Enrichment minimum:** At least one of Steps 3 (Prometheus), 4 (ArgoCD), 5 (Logs), 6 (Certs), 7 (AWS), or 10 (CI/CD) must succeed. If all six enrichment steps fail, the RCA is posted with a prominent caveat: `Limited evidence — only core K8s state available. Confidence reduced.` Merged confidence is capped at 50% regardless of LLM output. PR lane is blocked.

**Completeness score:** `steps_completed / applicable_steps` (dynamic denominator). A step is **applicable** if its prerequisite is configured:

| Step                 | Applicable when                                |
| -------------------- | ---------------------------------------------- |
| 1: Pod & Deploy      | Always                                         |
| 2: Events & Alerts   | Always                                         |
| 3: Prometheus Trends | `PROMETHEUS_URL` is set                        |
| 4: ArgoCD Sync       | `ARGOCD_BASE_URL` is set                       |
| 5: Log Signals       | Always                                         |
| 6: Cert & Secret     | Always (K8s secrets always exist)              |
| 7: AWS Resources     | `AWS_PROFILE` or in-cluster IAM role available |
| 8: Image-to-Repo     | `INCLUDE_REPO_MAP=1`                           |
| 9: Revisions         | `INCLUDE_IMAGE_REVISION=1`                     |
| 10: CI/CD            | `INCLUDE_CI_SIGNAL=1`                          |

Steps 0 and 11 are excluded from completeness. Non-applicable steps are excluded from both numerator and denominator — they don't penalize completeness. Logged per-incident as `evidence_completeness` + `applicable_steps` count. If completeness drops below 60% across 5 consecutive non-aborted incidents, emit a meta-alert: infrastructure health check needed.

### Step 0: Linear Incident Memory Lookup (NEW)

Runs **after Steps 1-2** (core signals) but **in parallel with Steps 3-10** (enrichment). Step 0 uses the outputs of Step 1 (pod names, deployment states) and Step 2 (events, alert names) as search inputs — it cannot run before these core steps produce their data. The "Step 0" numbering reflects its role as pre-RCA context (consumed by Step 11), not its execution order in the pipeline.

**Pre-triage search (using Step 1/2 outputs):**

- Extract key signals from Step 1/2 outputs: affected pod names, error patterns, impacted services
- Search Linear API: Platform team, last 90 days, title prefix `[Incident]` (matches bot-created tickets which use `[Incident] {severity}: {description}` title format — see Ticket fields) OR labels `Bug` + `Monitoring` (both always applied to bot-created tickets)
- Match on: title keywords, description content (including `incident_id`), service names
- Return top 3-5 similar incidents with their resolution notes

**Output passed to Step 11:** List of similar past incidents with titles, descriptions, resolution context, and time-since-occurrence.

### New Step 3: Prometheus Metric Trends

**Script:** `prometheus-trends.sh`

Query key metrics over 1h/6h/24h windows via PromQL range queries against the in-cluster Prometheus (`prometheus-stack-kube-prom-prometheus.monitoring`).

**Targets:**

- Container CPU usage rate (by pod/container)
- Container memory working set (by pod/container)
- Request rate (if available via ServiceMonitor)
- HTTP error rate (5xx responses)
- Latency p99 (if available)
- Pod restart rate over time

**Detection logic:**

- Resource creep: memory climbing >10% over 6h window toward limit
- Error spike: 5xx rate >5% of total requests in 1h window
- Latency degradation: p99 >2x baseline in 1h window
- Restart acceleration: restart rate increasing over 24h

**Output:** TSV with columns: `metric_name`, `pod`, `current_value`, `6h_trend`, `24h_trend`, `threshold_proximity`, `status` (ok/warning/critical)

### New Step 4: ArgoCD Sync & Drift State

**Script:** `argocd-sync-status.sh`

Query ArgoCD API for applications targeting the monitored namespaces.

**Checks:**

- Sync status: Synced / OutOfSync / Unknown
- Health status: Healthy / Degraded / Progressing / Missing / Suspended
- Last sync time and result (success/failure)
- Drift details: which resources differ between git and live state
- Recent sync operations (last 3)

**Detection logic:**

- OutOfSync for >1h → warning
- Failed sync in last 30m → critical signal
- Degraded health → correlate with pod state from Step 1

**Output:** TSV with columns: `app_name`, `sync_status`, `health_status`, `last_sync_time`, `last_sync_result`, `drift_summary`

### New Step 6: Cert & Secret Health

**Script:** `cert-secret-health.sh`

**TLS certificate checks:**

- Parse ingress resources for TLS secrets
- Extract cert expiry from secret data (`kubectl get secret -o jsonpath`)
- Flag: expiring within 7d (critical), 14d (warning), 30d (info)

**Vault lease checks (if VAULT_ADDR configured):**

- Query active leases via Vault API
- Check TTL remaining on dynamic secrets
- Flag: TTL <1h (critical), <6h (warning)

**K8s secret freshness:**

- Check creation/modification timestamps
- Flag: secrets unchanged for >90d (info — potential rotation needed)

**Output:** TSV with columns: `resource_type` (cert/vault-lease/k8s-secret), `name`, `namespace`, `expiry_or_age`, `days_remaining`, `status` (ok/info/warning/critical). The `info` status is used for non-urgent advisory signals (e.g., certs expiring in 30d, secrets unchanged for 90d) — included in evidence for completeness but excluded from severity scoring.

### New Step 7: AWS Resource Signals (Runtime-Impacting Only)

**Script:** `aws-resource-signals.sh`

Uses existing IAM role/profile (`AWS_PROFILE=morpho-infra-terraform-k8s` or in-cluster role).

**Runtime-impacting checks (in incident pipeline):**

- EC2 instance status checks (system status, instance status) for EKS nodes
- EBS volume utilization (attached volumes, available space)
- EKS node group status and scaling activity
- Spot instance interruption notices (if using spot)

**Output:** TSV with columns: `resource_type`, `resource_id`, `status`, `utilization_pct`, `notes`

**Cost signals moved to daily health report (not incident pipeline):**
AWS Cost Explorer queries (monthly spend, top contributors, anomaly detection) are slow (~3-5s), coarse-grained (daily), and not actionable during real-time triage. These run on a separate daily cron (e.g., 08:00 UTC) and post a cost digest to `#staging-infra-monitoring`. They do not participate in the incident evidence pipeline or severity scoring.

### Step 11: LLM-Synthesized RCA

**Trigger:** Only when `health_status=incident` (no LLM call on healthy heartbeats).

**Mode:** Controlled by `RCA_MODE` env var:

- `single` (default) — Codex-only synthesis
- `dual` — Codex + Claude parallel investigation with iterative cross-review
- `heuristic` — legacy heuristic scoring (no LLM)

#### Single-Model Mode (Default — Phase 6a)

**Default model: Codex.** Claude is reserved for the dual-model lane only. The bot's existing OpenAI/Codex credentials power the default single-model RCA. `ANTHROPIC_API_KEY` is only required when `RCA_MODE=dual`.

**Input to Codex:**

- Complete evidence bundle from Steps 0-10 (TSV output + Linear matches)
- Relevant runbook/playbook references from bundled skills
- Slack thread context if this is an ongoing incident

**Prompt structure:**

Both models (when dual mode is active) receive identical prompts. The LLM must return structured JSON matching the hypothesis schema below — not free text.

```
You are an SRE analyzing an incident in {namespace} on {cluster}.

Evidence from automated triage:
{steps_1_through_10_output}

Similar past incidents from Linear:
{linear_search_results}

Reference playbooks:
{relevant_skill_snippets}

## Hypothesis Taxonomy

You MUST classify each hypothesis into exactly one canonical_category from this
controlled list. Use hypothesis_id for the specific variant within the category:

- resource_exhaustion: OOM, CPU throttle, disk full, connection pool, file descriptors
- bad_deploy: broken image, missing config, wrong env, failed rollout, bad merge
- config_drift: ArgoCD out-of-sync, manual kubectl change, secret mismatch, stale config
- network_connectivity: DNS failure, TLS error, service mesh issue, firewall/SG, timeout
- dependency_failure: upstream service down, database unreachable, cache unavailable
- cert_or_secret_expiry: TLS cert expired, Vault lease exhausted, rotated secret not propagated
- scaling_issue: HPA maxed, node group at capacity, spot interruption, pending pods
- data_issue: corrupt data, migration failure, schema mismatch, storage backend error
- unknown: insufficient evidence to classify confidently (fallback only; requires human review)

Return a JSON object with these fields:
- hypotheses: array of objects, each with:
  - hypothesis_id: a short snake_case identifier from a **controlled vocabulary** — must be `{canonical_category}:{specific_variant}` where `specific_variant` is one of a documented set per category. The canonical vocabulary is versioned and stored in-repo at `deploy/skills/morpho-sre/rca_hypothesis_ids.v1.json` — a JSON map of `category → [variant_1, variant_2, ...]`. The full vocabulary is included verbatim in the LLM prompt. LLM output is validated against this file; any `hypothesis_id` not in the vocabulary is auto-mapped to `{category}:other` with the original variant preserved in a `variant_note` field. Examples: `resource_exhaustion:redis_pool`, `resource_exhaustion:oom_memory_limit`, `bad_deploy:config_mismatch`. This ensures convergence checks compare structured IDs, not free-form text. If no existing variant fits, the model uses `{category}:other` and describes the novel variant in the `description` field. **`unknown` special case:** if `canonical_category=unknown`, `hypothesis_id` must be exactly `unknown:insufficient_evidence` (no free-form variants for unknown).
  - canonical_category: one of the categories above (REQUIRED)
  - description: one-paragraph explanation
  - confidence: integer 0-100
  - evidence_keys: array of step IDs + signal names from the evidence bundle that support this (e.g., ["step03:memory_creep", "step05:oom_signal"])
  - disproving_evidence: array of evidence that would disprove this
  - diagnostic_commands: array of kubectl/curl commands to confirm
  - remediation_steps: array of recommended actions
- blast_radius: one paragraph on affected services and user impact
- pattern_analysis: one paragraph on recurrence (or "No matching pattern" if none)
```

**Output schema (unified across all modes):**

```json
{
  "mode": "dual",
  "rca_version": 1,
  "incident_id": "hb:morpho-dev:resource_exhaustion:20260302T1430:a3f19bc2",
  "evidence_fingerprint": "sha256-of-current-signals",
  "evidence_completeness": 0.82,
  "hypotheses": [
    {
      "rank": 1,
      "hypothesis_id": "resource_exhaustion:redis_pool",
      "canonical_category": "resource_exhaustion",
      "description": "...",
      "confidence": 85,
      "evidence_keys": ["step03:memory_creep", "step05:connection_refused"],
      "disproving_evidence": ["..."],
      "diagnostic_commands": ["..."],
      "remediation_steps": ["..."]
    }
  ],
  "blast_radius": "...",
  "pattern_analysis": "...",
  "model_metadata": {
    "primary": { "model": "openai-codex", "status": "ok", "latency_ms": 12000 },
    "secondary": { "model": "anthropic-claude", "status": "ok", "latency_ms": 11800 }
  },
  "merged_confidence": 85,
  "agreement_score": 0.71,
  "convergence": {
    "converged": true,
    "review_rounds": 0,
    "agree_with_peer": [true, true]
  },
  "degradation_note": null
}
```

**Schema note:** Two schemas exist: (1) **Internal per-model response** — includes `agree_with_peer`, `review_notes`, `variant_note` (preserved when `hypothesis_id` is auto-mapped to `:other`), and all hypothesis fields. Used only during the cross-review loop, never exposed externally. The `variant_note` is preserved in `model_metadata` for auditing but not surfaced in Slack/Linear output. (2) **Merged external schema** (above) — the unified output consumed by Slack formatter, Linear ticket template, PR gate, and outbox. The `convergence` object is populated in dual mode; `null` in single/heuristic. `model_metadata` contains internal details (latency, per-model status, review notes) — logged but never surfaced in Slack/Linear output.

**Fallback chain:** Codex call fails → heuristic scoring. Alert includes note: "RCA generated via heuristic fallback — Codex unavailable."

#### Dual-Model Mode (Phase 6b — Conditional Upgrade)

**Claude is invoked only during active incident investigations in dual mode** — this includes both the investigation phase (evidence analysis, log interpretation, metric correlation) and the RCA synthesis phase. Claude is never used for: thread archival summarization, daily cost reports, pattern detection, Slack thread monitoring, or any other non-incident bot function. Codex handles all non-incident LLM tasks regardless of `RCA_MODE`.

**Activation criteria — statistical rigor required:**

- Minimum sample: 50 incidents triaged in single-model mode (not 20)
- Measurement: human acceptance rate tracked via Slack reaction (thumbs-up = correct, thumbs-down = wrong)
- **No-reaction handling:** Incidents with no reaction after 4h are tagged `unreviewed`. If >40% of incidents are `unreviewed`, the bot posts a weekly nudge to `#staging-infra-monitoring`: `{n} RCA reports unreviewed — please react with thumbs-up/down to help calibrate accuracy.` Unreviewed incidents are counted as **neither correct nor incorrect** — they reduce the effective sample size but do not skew the acceptance rate. The 50-incident minimum applies to **reviewed incidents only** (those with a reaction).
- Gate: **advisory, not automatic.** The bot computes the bootstrap CI and **recommends** dual-model activation if severity-weighted acceptance rate is below 80% with 90% confidence — but switching still requires explicit operator action (`RCA_MODE=dual` in deploy config). The recommendation post includes CI bounds and sample size. Method: **bootstrap confidence interval** (10,000 resamples of reviewed incidents, weighted acceptance per resample). Recommend dual mode only if the upper bound of the 90% CI is <80%.
- Operator override remains allowed (`RCA_MODE=dual`) even if the advisory gate does not trigger, with preconditions: (1) `ANTHROPIC_API_KEY` valid/probed, (2) operator acknowledges added cost/latency, (3) dual applies only to severity >= MEDIUM (`LOW` stays single via Step 11 mode resolver), and (4) runtime safety override (below) remains active.
- **Runtime safety override (canonical downgrade/recovery state machine):**
  - Persist dual-mode outcomes at `${INCIDENT_STATE_DIR}/rca-convergence-stats.tsv` (`ts, converged|not_converged`) and runtime mode state at `${INCIDENT_STATE_DIR}/rca-mode-state.tsv` (`state=normal|downgraded`, `updated_ts`). Both files are read/written under flock.
  - On each Step 11 invocation, compute both windows from stats: `rate_7d/samples_7d` (last 7 days) and `rate_14d/samples_14d` (last 14 days).
  - Enter downgrade (`normal` -> `downgraded`) when `samples_7d >= 10` AND `rate_7d > 30%`.
  - While downgraded, run one probe dual-mode RCA per 24h (first severity >= MEDIUM incident that day) to avoid permanent downgrade deadlock.
  - Exit downgrade (`downgraded` -> `normal`) when `samples_14d < 10` (insufficient evidence) OR (`samples_14d >= 10` AND `rate_14d < 15%`).
  - Effective mode resolution: if runtime state is `downgraded`, force `effective_mode=single` regardless of `RCA_MODE`; otherwise resolve from `RCA_MODE` + severity gate.
  - Alert transitions to `#staging-infra-monitoring`: enter/exit downgrade, current rates/samples, and override guidance (`delete rca-convergence-stats.tsv` or set `RCA_MODE=single`).
- Severity weighting: CRITICAL/HIGH incidents weighted 2x, MEDIUM/LOW weighted 1x. Weighted acceptance = sum(weight_i \* correct_i) / sum(weight_i).
- Decision is logged and reversible: `RCA_MODE` can be switched back to `single` at any time

**Architecture:** Both models independently investigate the evidence and produce an RCA. Then each reviews the other's work and revises. They iterate until they converge on a single agreed report, or hit a max iteration cap (2 review rounds). On convergence, the merged report is submitted. On non-convergence after max rounds, the Codex-primary report is emitted with a confidence penalty and a human-review flag (see "Max iterations" below).

**Execution flow — Iterative Cross-Review Loop:**

```
Round 0: Independent Investigation (parallel)
  ├─ Codex: evidence bundle → structured RCA (JSON)
  └─ Claude: evidence bundle → structured RCA (JSON)
        ↓
  Convergence check (canonical contract):
    same category + same hypothesis_id + Jaccard>=0.6
    + |A∩B|>=2 (Round 0: agree_with_peer NOT required;
               Round 1+: + both agree_with_peer)
  ├─ YES → merge into final report, submit
  └─ NO ↓

Round 1: Cross-Review (parallel)
  ├─ Codex receives Claude's RCA → review + revised RCA
  └─ Claude receives Codex's RCA → review + revised RCA
        ↓
  Convergence check (same canonical contract)
  ├─ YES → merge, submit
  └─ NO ↓

Round 2: Final Cross-Review (parallel)
  ├─ Codex receives Claude's Round 1 revision → final position
  └─ Claude receives Codex's Round 1 revision → final position
        ↓
  Convergence check (same canonical contract)
  ├─ YES → merge, submit
  └─ NO → emit Codex-primary report, low-confidence flag
```

**Round 0 — Independent Investigation:**

1. Fire Codex and Claude in parallel with the same evidence bundle and prompt
2. Both return structured JSON with `hypothesis_id`, `canonical_category`, and `evidence_keys`
3. Check convergence immediately — if they already agree, no review rounds needed

**Round 1+ — Cross-Review:**
Each model receives the other's RCA output and a review prompt:

```
You are reviewing a peer SRE's incident analysis. Here is the original evidence:
{evidence_bundle}

Here is the peer's RCA:
{other_model_rca_json}

Here is your own previous RCA:
{own_previous_rca_json}

Review the peer's analysis:
1. Do you agree with their top hypothesis (canonical_category + evidence)?
   If not, what evidence contradicts it?
2. Did they identify evidence you missed, or vice versa?
3. Produce a revised RCA incorporating the strongest elements of both.
   - If you now agree with the peer's root cause, adopt their canonical_category.
   - If you still disagree, state your hypothesis with updated evidence.

Return the same structured JSON schema (hypothesis_id, canonical_category,
evidence_keys, confidence, etc.) plus:
- review_notes: what you changed and why
- agree_with_peer: true/false
```

**Convergence check (after each round):**

- Compare `canonical_category` of each model's #1 hypothesis
- Compare `hypothesis_id` (specific variant within category)
- Compute Jaccard index on `evidence_keys`: `|A ∩ B| / |A ∪ B|` (empty set → 0)
- Count overlapping specific evidence signals: `|A ∩ B|` (raw count, not ratio)
- **Converged:** ALL of: same `canonical_category` AND same `hypothesis_id` (compared as structured `category:variant` tokens from the controlled vocabulary — not free-text equality) AND Jaccard >= 0.6 AND `|A ∩ B|` >= 2 (at least 2 shared evidence keys). **Round-specific `agree_with_peer` rule:** In Round 0 (independent investigation), models have not seen each other's work — `agree_with_peer` is not available and is **not required** for convergence. The four structural criteria above suffice. In Round 1+ (cross-review), both models must also set `agree_with_peer: true` (5th condition). This enables the "fast converge" path at Round 0 when both models independently reach the same conclusion, saving 2-4 LLM calls. → merge into final report
- **Weak convergence:** same `canonical_category` but different `hypothesis_id` variant (e.g., both say `resource_exhaustion` but one says `resource_exhaustion:redis_pool` and other says `resource_exhaustion:oom_memory_limit`) → does NOT count as converged. Models must agree on the specific variant, not just the broad category. This prevents false agreement from being used to relax PR safety gates. **Special case for `{category}:other`:** If both models use `{category}:other` (novel variant not in the controlled vocabulary), `hypothesis_id` string equality is trivially satisfied (`resource_exhaustion:other` == `resource_exhaustion:other`). In this case, the convergence check adds an extra gate: the `description` fields must have >80% token overlap (bag-of-words intersection / union). If description overlap is ≤80%, the convergence check fails despite matching `hypothesis_id` — the models agree on the category but describe fundamentally different novel variants. This is the only case where `description` content participates in convergence. For all named variants (non-`other`), `hypothesis_id` string equality is the sole identity check.
- **Not converged:** proceed to next round (if budget remains)

**Merge (on convergence):**

- Pick the hypothesis with richer `evidence_keys` as the primary
- `merged_confidence` = average of both models' final confidence scores
- `agreement_score` = Jaccard of final `evidence_keys`
- `review_rounds` = number of rounds taken to converge (0, 1, or 2)
- Include `review_notes` from both models in `model_metadata` (internal only)

**Max iterations:** 2 review rounds (Round 0 + Round 1 + Round 2 = up to 3 exchanges per model, 6 total LLM calls worst case). If still not converged after Round 2:

- Emit the Codex RCA (primary model) as the report
- Set `agreement_score = 0`, reduce `merged_confidence` by 20%
- `degradation_note: "Models did not converge after 2 review rounds — Codex-primary report, low confidence"`
- Flag for human review in Slack

**Degradation modes (all produce the same output schema):**

- Both converge (Round 0) → merged output, 2 LLM calls total, `degradation_note: null`
- Both converge (Round 1) → merged output, 4 LLM calls total, `degradation_note: null`
- Both converge (Round 2) → merged output, 6 LLM calls total, `degradation_note: null`
- Both complete, don't converge → Codex-primary, 6 LLM calls, `degradation_note` set, flagged
- Codex only (Claude unavailable) → Codex output, `degradation_note: "Claude unavailable — Codex-only RCA"`
- Claude only (Codex unavailable) → Claude output, `degradation_note: "Codex unavailable — Claude-only RCA"`
- Neither → heuristic fallback, `degradation_note: "Both LLM providers unavailable — heuristic fallback"`

**PR eligibility in degraded dual modes:** When `RCA_MODE=dual` but one model is unavailable, the effective output is single-model. PR gate behavior: **Codex-only (Claude unavailable):** Apply single-model PR gates (confidence >= 90%, evidence >= 0.7, human ack required). The output has no convergence data, so dual gates (agreement_score, convergence) are inapplicable. **Claude-only (Codex unavailable):** Same as Codex-only — apply single-model gates. **Neither available (heuristic fallback):** PR lane is hard-blocked (heuristic output never qualifies for PR). These degraded modes are handled by the Step 11 mode resolver, which sets the effective mode in the output schema's `mode` field — the PR gate reads `mode` to determine which gate table row applies.

**Slack presentation:** Always one authoritative RCA — the converged report. Never "Codex says / Claude says." If models did not converge, output says "Low confidence — peer review did not reach consensus, manual investigation recommended." Convergence details and review notes are internal only (logged in `model_metadata`).

**Early-post UX for dual-mode latency:** Since dual-mode p99 can reach 119s, the bot posts a brief early status to the Slack thread at the start of Step 11 dual: `Analyzing incident with dual-model review... (est. 30-60s)`. The final RCA replaces this message via `chat.update` (not a new message). If the LLM phase completes within 15s (Round 0 convergence), skip the early post — it would flash and disappear. **Crash safety:** The early-post `message_ts` is persisted to the spool output file (alongside the RCA JSON) immediately after `chat.postMessage` succeeds, with an explicit `fsync` before continuing to ensure durability. On crash recovery, the next triage run reads the spool file, finds the persisted `message_ts`, and uses `chat.update` to replace the orphaned "Analyzing..." message with the final RCA (or a failure notice: `Analysis interrupted — retrying on next heartbeat`). If no `message_ts` is found in the spool file (early post was skipped or never succeeded), the final RCA is posted as a new message. This mitigates most orphaned "Analyzing..." messages after crashes. **Residual risk:** A crash in the narrow window between `chat.postMessage` returning the early-post `message_ts` and the spool file being written to disk will still leave an orphaned message. This window is <100ms in practice. Mitigation: the on-call can manually delete the orphaned message, and the next heartbeat's full RCA post (as a new message, since no `message_ts` was persisted) provides the correct information. This is an acceptable trade-off — eliminating the window entirely would require a pre-post spool write (adding latency to the hot path for an extremely rare crash scenario).

**Config (Step 11 core env vars):**

- `RCA_MODE=single|dual|heuristic` (default: `single`)
- `ANTHROPIC_API_KEY` (required for `dual` mode only; ignored in `single` mode which uses Codex)
- `RCA_LLM_TIMEOUT_MS=15000` (per-model, per-round timeout)

**Additional env gates (set in deploy config, not Step 11-specific):**

- `DUAL_PR_GRADUATED=true|false` (PR lane graduation flag — see Optional PR Lane)
- `PR_APPROVER_SLACK_IDS` (comma-separated Slack user IDs in `U...` format for PR approval — validated at deploy time; names like `florian` are not valid Slack user IDs)
- `LINEAR_TEAM_ID`, `LINEAR_PROJECT_NAME`, `LINEAR_ASSIGNEE` (Linear ticketing config)
- `PROMETHEUS_URL`, `ARGOCD_BASE_URL`, `INCLUDE_REPO_MAP`, `INCLUDE_IMAGE_REVISION`, `INCLUDE_CI_SIGNAL` (step applicability flags)

Existing OpenAI/Codex env vars stay unchanged. Hardcoded defaults (not env vars until proven necessary):

- Max review rounds: **2** (up to 3 exchanges per model)
- Convergence criteria: same `canonical_category` AND same `hypothesis_id` AND Jaccard >= 0.6 AND `|A ∩ B|` >= 2. Round 0: these 4 conditions suffice (no `agree_with_peer` available). Round 1+: additionally both `agree_with_peer: true`. (See "Convergence check" section — this is the single canonical definition.)
- Non-convergence confidence penalty: **20%** reduction to `merged_confidence`
- Canonical hypothesis categories: 8 controlled values + `unknown` (9 total — see prompt taxonomy; `unknown` triggers `[NEEDS REVIEW]` + PR hard-block)
- Model identifiers: `openai-codex` (primary/default), `anthropic-claude` (secondary/dual-only)

### RCA Versioning Policy

Incidents evolve. The bot may re-triage the same incident on subsequent heartbeats as new evidence appears (new log lines, metrics changes, human activity in thread). RCA updates follow these rules:

- Each RCA output carries `incident_id` (stable, see Incident Identity), `evidence_fingerprint` (volatile hash of current signals), and `rca_version` (integer, starts at 1).
- **Same `incident_id`, same `evidence_fingerprint`:** No RCA update posted — the RCA is unchanged so there is nothing new to report. **Exceptions:** (1) If the state file shows a pending outbox entry (Slack or Linear write not yet confirmed — see outbox below), retry the external write before skipping. (2) The 30m digest line (see below) is still posted even when evidence is unchanged — this is a keep-alive status message, not an RCA update. The digest is gated on `last_seen_ts` advancing (proof the incident is still detected), not on fingerprint change.
- **Same `incident_id`, different `evidence_fingerprint`** (signals evolved within same incident): Bump `rca_version`. Post an update reply in the same Slack thread with header: `RCA Update (v{n})`. Update the Linear ticket description (replace RCA section, keep prior versions as collapsed block).
- **Outbox pattern for external writes:** State file advances (`rca_version` bump, `evidence_fingerprint` update) must not outrun external writes. Each row carries outbox columns: `slack_post_status`, `slack_post_attempts`, `linear_post_status`, `linear_post_attempts`. **State machine per channel:**

  ```
  MAX_ATTEMPTS = 3  (total attempts, not retries)

  pending (attempts=0)
    → increment attempts to 1 (under flock, before API call)
    → attempt POST
    → POST succeeds → sent (terminal)
    → POST fails, attempts < MAX_ATTEMPTS → failed_retryable
    → POST fails, attempts >= MAX_ATTEMPTS → failed_terminal (alert emitted)

  failed_retryable (attempts=N where 1 <= N < MAX_ATTEMPTS)
    → next heartbeat: increment attempts to N+1 (under flock, before API call)
    → attempt POST
    → POST succeeds → sent (terminal)
    → POST fails, attempts < MAX_ATTEMPTS → failed_retryable
    → POST fails, attempts >= MAX_ATTEMPTS → failed_terminal (alert emitted)

  sent → terminal (no further action)
  failed_terminal → terminal (no further action, alert already emitted)
  ```

  **Canonical sequence (aligned with write-order + version-safety invariants):**
  1. Compute `target_rca_version` + `target_fingerprint` for this run.
  2. Write + `fsync` spool payload for `(incident_id, target_rca_version)` **before** any state bump.
  3. Under flock, persist row state for `target_rca_version`:
     - if this is a new version, bump `rca_version` and reset both channel outboxes to `pending/0`
     - if this is a retry of the current version, keep current `rca_version`
  4. For each channel (`slack`, `linear`), claim an attempt under flock:
     - read row; if `row.rca_version != target_rca_version`, this worker is stale → stop channel work and mark stale spool superseded
     - if status is `pending` or `failed_retryable`, increment attempts (`N -> N+1`) **before** API call and persist
  5. Execute channel API call outside lock.
  6. Finalize under flock with a compare-and-set on version:
     - re-read row; if `row.rca_version != target_rca_version`, do **not** mutate outbox status/attempts (stale writer)
     - otherwise: success -> `sent`; failure -> `failed_retryable` (`attempts < 3`) or `failed_terminal` (`attempts >= 3`)

  **Version-keyed outbox invariant:** Every outbox mutation is keyed by `(incident_id, channel, rca_version)`. Writers for older versions must never overwrite status for newer versions. This prevents the race where a delayed `vN` worker marks channel `sent` after `vN+1` was already created, which would otherwise suppress the newer RCA.

  **Stale-version suppression:** Before posting, compare spool `rca_version` to row `rca_version`. If spool version is older, silently ack it as superseded and skip external writes.

  **Retry/reset behavior:** Exactly 3 total attempts per channel per version (initial + 2 retries). If fingerprint changes, new `rca_version` always resets outbox to `pending/0` even from `failed_terminal`. If fingerprint is unchanged and status is `pending|failed_retryable`, retry instead of silent skip.

  **Write-order invariant (hard requirement):** spool payload `fsync` must happen before state `rca_version` bump. Otherwise a newer state version can exist without durable payload, causing lost updates.
  **Outbox vs spool — scope and precedence:** The outbox (state file columns) and the spool (filesystem files) serve complementary roles in a unified delivery pipeline:
  - **Spool** is the universal Step 11 output sink. Both the main pod (Slack-triggered) and the cron pod write triage results to spool files. The early lease ensures at most one writer per dedup window. The spool file contains the RCA JSON and, for dual-mode early-post, the persisted `message_ts` for crash-safe `chat.update`.
  - **Outbox** (state file columns) tracks the delivery status of each incident's Slack and Linear posts across heartbeats. After a spool file is posted to Slack (or a direct Slack write succeeds), the outbox status is updated to `sent`. If the POST fails, outbox tracks `failed_retryable` with attempt count for next-heartbeat retry.
  - **Flow (standard, non-early-post):** Step 11 → write spool file (RCA JSON) → attempt Slack POST → update outbox status in state file. **Flow (dual-mode with early-post):** Step 11 starts → early Slack POST (`chat.postMessage` "Analyzing...") → persist `message_ts` to spool file + `fsync` → run LLM rounds → append final RCA to spool file → `chat.update` with `message_ts` → update outbox status. In both flows, the spool file is written before the final Slack write is confirmed. The spool `.ack` marker (per-key pre-Phase-5, per-key-per-version post-Phase-5) prevents duplicate posts from concurrent runs. The outbox status prevents duplicate posts across heartbeats. If both fire for the same window, the early lease (mkdir) ensures only one runs Step 11 — the loser skips entirely.
  - **Crash recovery:** On startup/next heartbeat, check for un-acked spool files (Step 11 completed but Slack POST didn't happen or wasn't confirmed). If found, read the spool file (including any persisted `message_ts`), attempt the Slack POST (or `chat.update` if `message_ts` exists), update outbox status. This makes spool the durable record and outbox the delivery-status tracker — no conflict.

  **At-least-once semantics and idempotency:** This is explicitly an at-least-once outbox, not exactly-once. Crash between a successful POST and the `sent` status update will cause a repost on the next heartbeat. This is acceptable because both write targets are idempotent or tolerant of duplicates: **Slack** — a duplicate RCA post in the same thread is benign (same content, on-call sees it twice at worst; for updates, `chat.update` with the persisted `message_ts` is inherently idempotent). **Linear** — description updates are idempotent (same content replaces same section); ticket creation is deduped by the existing `incident_id`-in-description search (see Post-Triage Ticket Creation). The outbox does **not** guarantee exactly-once delivery and the design does not require it — the cost of a rare duplicate Slack message is far lower than the cost of a lost RCA update.

- **Different `incident_id`:** New incident. New Slack thread reply. New or separate Linear ticket.
- **30m digest cadence (keep-alive, not RCA update):** If the incident persists across heartbeats with no material change (same `evidence_fingerprint`), post a brief status line to the Slack thread: `Still active — no change in RCA (v{n}). Next check in 30m.` This is **not** subject to the "silent skip" rule above — the digest is a keep-alive signal to the on-call that the bot is still monitoring, distinct from an RCA version bump. The digest is posted once per 30m heartbeat that detects the incident as still active (i.e., `last_seen_ts` updated). No Linear ticket update for digest-only heartbeats.

### Linear Incident Memory

#### Post-Triage Ticket Creation (after Step 11)

**Idempotency:** Ticket dedup uses a two-layer lookup — local state file first (authoritative), Linear API search as fallback (for state file loss after PVC corruption or manual cleanup).

**The create/recover path (empty `linear_ticket_id`) begins under flock** — the initial state-file read and reservation write are inside the flock critical section to prevent two writers from both seeing an empty `linear_ticket_id` and racing to create duplicate tickets. The flock is released before the Linear API call (see pseudocode below). **The update path (populated `linear_ticket_id`) releases the lock early** — see pseudocode:

```
flock(STATE_FILE.lock) {
  1. Read state file for current incident_id
  2. If linear_ticket_id populated:
     a. Read ticket_id (local variable)
     b. Check `linear_post_status`:
        - if `sent` and `rca_version` unchanged → skip update
        - if `failed_terminal` and `rca_version` unchanged → skip update (alert already emitted)
        - if `pending` or `failed_retryable` → proceed to update (retry path)
     c. Compute `target_rca_version` (current row version after any bump/reset)
     d. If status is `pending|failed_retryable`, increment `linear_post_attempts`
        under lock BEFORE API call; persist state
     e. Release lock
     f. Attempt Linear ticket update (outside lock — idempotent, no creation race)
     g. Re-acquire flock, re-read row:
        - if row.rca_version != target_rca_version: stale writer, do not mutate status
        - else success -> set `linear_post_status=sent`
        - else failure -> set `failed_retryable` if attempts < 3, `failed_terminal` if >= 3
        Release lock
  3. If linear_ticket_id empty:
     a. If `linear_reservation` is fresh (`pending:{ts}`, age <=120s), skip (another writer creating)
     b. If `linear_reservation` is stale (>120s), clear it and continue
     c. Write fresh reservation marker to sidecar field `linear_reservation` (not `linear_ticket_id`)
        with value `pending:{timestamp}`. Set `linear_post_status=pending`.
     d. Increment `linear_post_attempts` under lock BEFORE API call.
     d1. Capture `target_rca_version` from row before releasing lock.
     e. Release lock  ← lock released BEFORE API call
     f. Search Linear API for open ticket with incident_id in description
     g. If found → flock, write linear_ticket_id to state, clear `linear_reservation`,
        then:
        - if row.rca_version == target_rca_version: set `linear_post_status=sent`
        - if row.rca_version != target_rca_version: keep current status (newer version owns outbox)
        release
     h. If not found → create new ticket via Linear API →
        flock, write linear_ticket_id to state, clear `linear_reservation`,
        then:
        - if row.rca_version == target_rca_version: set `linear_post_status=sent`
        - if row.rca_version != target_rca_version: keep current status (newer version owns outbox)
        release
     i. On API failure: flock, clear reservation (set linear_reservation back to empty),
        then:
        - if row.rca_version == target_rca_version: set `linear_post_status` to `failed_retryable`
          if current attempts < 3 or `failed_terminal` if current attempts >= 3
        - if row.rca_version != target_rca_version: keep current status (newer version owns outbox)
        release
        (next heartbeat retries only `failed_retryable`; `failed_terminal` is terminal)
}
```

**Two-phase reservation:** The flock is held only for local state reads/writes (microseconds), never across Linear API calls. The `linear_reservation` sidecar field (separate from `linear_ticket_id`) holds the `pending:{timestamp}` marker during creation. This separation ensures that: (a) `linear_ticket_id` is always either empty or a valid Linear ticket ID — readers never encounter a `pending:*` value where they expect a ticket ID, and (b) the reservation marker doesn't confuse downstream logic that reads `linear_ticket_id` (state file readers, outbox logic, ticket update path). A stale reservation (older than 120s — generous margin beyond the 5s API timeout + 3s retry delay + network jitter) is treated as abandoned and cleared by the next writer. The 120s TTL (instead of the original 30s) provides safety margin for slow Linear API responses, DNS resolution delays, and the 3s dedup retry — the API probe can take up to 5s timeout + 3s delay + 5s second attempt = 13s even in normal slow-path scenarios. This bounds worst-case lock hold time to <1ms regardless of Linear API latency.

**Lock scope:** The flock is held only for local state file reads and writes — never across Linear API calls. For the update path (step 2), the lock is released after the state write. For the create-or-recover path (step 3), a `pending:{timestamp}` reservation is written under lock, then the lock is released before the API call. The reservation prevents concurrent creates. On API completion, the lock is briefly re-acquired to finalize the `linear_ticket_id`; outbox status updates are applied only if `row.rca_version == target_rca_version` (stale writers must not clobber newer-version status). Worst-case lock hold time is <1ms (local file I/O only). This is safe for any heartbeat cadence and does not serialize unrelated incident updates behind a slow Linear API.

**Concurrency model — two writer paths:**

The Slack-triggered triage (main pod) and the cron fallback CronJob both write to the same PVC-backed state file. They are serialized via `flock` on the same lock file. This is safe because:

- Both run on the same PVC (ReadWriteMany or same-node ReadWriteOnce)
- `flock` is advisory but both writers use it (bot-controlled code, no external writers)
- The cron job is a short-lived pod that runs triage, writes state, and exits — it does not hold the lock long-term

**Atomicity (flock + atomic rename):**

1. Acquire exclusive `flock` on `${STATE_FILE}.lock`
2. Read current state file
3. Write updated content to `${STATE_FILE}.tmp` (same directory, same filesystem)
4. `fsync` the temp file
5. `mv` (atomic rename) `${STATE_FILE}.tmp` → `${STATE_FILE}`
6. `fsync` the parent directory (ensures the rename is durable on power-loss — required for EBS/EFS-backed PVC where directory entry updates may not be immediately flushed)
7. Release flock

This guarantees: no interleaved writes (flock serializes across both writer paths), no partial writes visible to readers (atomic rename), and crash recovery (either old or new file exists, never a partial). **Crash between Linear create and state write:** If the process crashes after creating a Linear ticket (step 3c) but before writing `linear_ticket_id` to the state file, the next heartbeat enters the create-or-recover path (step 3), hits the fallback search (step 3a), finds the orphaned ticket by `incident_id` in the description, and recovers the mapping. **Eventual consistency window:** The Linear API search is eventually consistent — a ticket created moments ago may not appear in search results for a few seconds. To mitigate: the fallback search retries once after a 3s delay before concluding "not found" and creating a new ticket. If a duplicate is still created (extremely rare), the bot detects it on the next heartbeat (two tickets with same `incident_id` in description) and closes the newer one with a link to the original.

**PVC requirement:** The state file PVC must support concurrent access from the main pod and the cron pod. **Phase 1 deliverable:** Start with `ReadWriteOnce` (RWO) + same-node scheduling (nodeAffinity or podAffinity pinning the CronJob to the same node as the main pod). This is simplest and works with any EBS-backed PVC. **If same-node scheduling proves unreliable** (scheduling constraints, node rotation): migrate to `ReadWriteMany` (RWX) via EFS-backed PVC (requires EFS CSI driver, already available in morpho-dev). **Fallback:** If neither RWO+affinity nor RWX is feasible, the cron job runs as `kubectl exec` into the main pod (same filesystem, flock works natively). The chosen storage mode is a Phase 1 deliverable — document the decision in the deployment manifest and test concurrent access before Phase 5 (which adds heavier state file writes). **Operational health check:** The cron pod writes a sentinel file (`${INCIDENT_STATE_DIR}/.cron-healthcheck-{ts}`) on each run and the main pod checks for it on startup and every 10 heartbeats. If no cron healthcheck file is found within the last 90 minutes (3× heartbeat cadence), emit alert to `#staging-infra-monitoring`: `Cron fallback writer has not run in >90m — PVC access or scheduling may be broken. Slack-independent triage is unavailable.` This detects node churn breaking same-node affinity before it silently disables the cron fallback during an actual Slack outage.

This prevents duplicate tickets across pod restarts, signal drift, and consecutive heartbeats.

**Linear entity preflight (lazy, non-fatal):**

The bot resolves and caches Linear entity IDs by name on first use (not at startup). Triage and Slack alerting must never depend on Linear availability — they are the core detection path. Linear ticketing is a downstream consumer that degrades independently.

**Initialization:** On first heartbeat that produces a ticket-worthy incident (severity >= MEDIUM), the bot runs the preflight if the cache is empty. All lookups use the Linear API against the Platform team.

**Required entities** (missing any → `LINEAR_AVAILABLE=false`, skip all ticketing):

| Entity   | Name                                       | Resolved to                                                                      | On missing               |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------ |
| Team     | Platform                                   | team ID (env: `LINEAR_TEAM_ID`, default: `993cc4f9-3ccf-4a59-ab14-2bc9f7484307`) | Degrade — skip ticketing |
| Project  | Infrastructure Backlog                     | project ID                                                                       | Degrade — skip ticketing |
| Assignee | env `LINEAR_ASSIGNEE` (default: `florian`) | user ID (resolved via `users` query filtered by `displayName`)                   | Degrade — skip ticketing |
| Label    | `Bug`                                      | label ID                                                                         | Degrade — skip ticketing |
| Label    | `Monitoring`                               | label ID                                                                         | Degrade — skip ticketing |

**Optional labels** (missing → log warning, create ticket without that label, ticketing continues):

| Entity | Name             | Resolved to | On missing                    |
| ------ | ---------------- | ----------- | ----------------------------- |
| Label  | `ai-ready`       | label ID    | Warn — omit label from ticket |
| Label  | `Security`       | label ID    | Warn — omit label from ticket |
| Label  | `Alerting`       | label ID    | Warn — omit label from ticket |
| Label  | `Devops`         | label ID    | Warn — omit label from ticket |
| Label  | `Technical debt` | label ID    | Warn — omit label from ticket |
| Label  | `Improvement`    | label ID    | Warn — omit label from ticket |

**On required-entity failure:** Log `linear_preflight_failed: {missing_entity}`, set `LINEAR_AVAILABLE=false`, post a one-time warning to `#staging-infra-monitoring`: `Linear ticketing degraded — missing required entity: {name}. Triage and Slack alerting continue normally.` **Retry policy:** Retry preflight on every heartbeat that produces a ticket-worthy incident (severity >= MEDIUM) while `LINEAR_AVAILABLE=false` — not just on new incidents. This ensures that an ongoing incident that was first detected during a Linear outage still gets a ticket once Linear recovers, rather than waiting for the next distinct incident. Retry is throttled to at most once per 5 minutes to avoid hammering a degraded Linear API.

**On optional-label failure:** Log `linear_label_missing: {name}`, cache `null` for that label ID (skip applying it to tickets), post a one-time info to `#staging-infra-monitoring`: `Linear label '{name}' not found — tickets will be created without this label.` Ticketing is not disabled.

**On Linear API unavailability** (timeout, 5xx, network): Same degradation path. Triage completes, Slack alert posts, ticket creation is skipped with `degradation_note: "Linear unavailable — ticket creation skipped"`. Retry follows the same policy as required-entity failure above: retry on every ticket-worthy heartbeat while `LINEAR_AVAILABLE=false`, throttled to at most once per 5 minutes.

Cached in memory as `LINEAR_ENTITY_CACHE` (map of `entity_type:name → id`). Cache is valid for the pod lifetime. All ticket creation and update calls use resolved IDs, never name strings.

**Ticket fields:**

- **Gate:** Only create if severity >= MEDIUM
- **Team:** env `LINEAR_TEAM_ID` (default: Platform `993cc4f9-...`, resolved ID from cache)
- **Project:** env `LINEAR_PROJECT_NAME` (default: `Infrastructure Backlog`, resolved ID from cache)
- **Status:** In Progress
- **Assignee:** env `LINEAR_ASSIGNEE` (resolved to Linear user ID via the entity preflight cache — see Required entities table above; not used as a raw string in API calls)
- **Priority mapping:** CRITICAL → Urgent, HIGH → High, MEDIUM → Medium
- **Title:** `[Incident] {severity}: {brief_description}` (e.g., `[Incident] CRITICAL: Redis connection pool exhaustion in morpho-dev`)
- **Labels** (apply all that match, using resolved IDs from cache):
  - `Bug` — always (incidents are bugs by nature)
  - `Monitoring` — always (detected by monitoring pipeline)
  - `ai-ready` — always (ticket has full RCA context for AI follow-up)
  - `Security` — if `canonical_category` is `cert_or_secret_expiry` or evidence contains authz/tls signals
  - `Alerting` — if triggered by BetterStack alert (`incident_id_source=bs_api`)
  - `Devops` — if `canonical_category` is `scaling_issue`, `config_drift`, or `bad_deploy`
- **Description template** (follows Eng Post-Mortem format from Notion — `[TEMPLATE] Eng Post-Mortem`):

All sections are bot-filled on initial creation using available evidence and LLM synthesis. The bot prefills its best assessment; the on-call engineer refines or overrides as needed during the post-mortem. Sections where the bot lacks data are marked with a `[NEEDS REVIEW]` placeholder instead of left blank.

```markdown
<!-- incident_id:{incident_id} -->
<!-- evidence_fingerprint:{evidence_fingerprint} -->
<!-- rca_version:{rca_version} | mode:{mode} | evidence_completeness:{pct}% -->

# Summary

- **What happened** (1-3 sentences): {top_hypothesis_description}
- **Impact** (who/what was affected): {blast_radius}
- **Root cause** (high-level): `{canonical_category}` — {hypothesis_1_title} (confidence: {confidence}%)
- **Resolution** (high-level): {remediation_steps_summary_or "[NEEDS REVIEW] Pending resolution"}

# Impact

- **Customer impact** (users/tenants affected, symptoms): {inferred_customer_impact_from_blast_radius_or "[NEEDS REVIEW] Assess customer-facing impact"}
- **Business impact** (SLO/SLA breaches, revenue, reputational): {slo_breach_estimate_if_available_or "[NEEDS REVIEW] Assess SLO/SLA breach"}
- **System impact** (services degraded, error rates): {blast_radius_services} — error rate: {error_rate_from_step3_if_available}, affected pods: {pod_count}
- **Scope** (products, regions, environments): namespace: `{namespace}`, cluster: `{cluster}`, severity: {severity_level} ({severity_score}/100)

# Timeline

| Timestamp                       | Person            | Event / Action                         | Links                          |
| ------------------------------- | ----------------- | -------------------------------------- | ------------------------------ |
| {first_symptom_utc_from_events} | (auto-detected)   | Incident start — first K8s event/alert | {prometheus_alert_link_if_any} |
| {detected_utc}                  | morpho-sre bot    | Heartbeat triage detected incident     |                                |
| {alert_utc}                     | morpho-sre bot    | Alert posted to Slack                  | {slack_message_link}           |
| {last_deploy_utc_if_suspect}    | (deploy pipeline) | Last relevant deployment               | {pr_url_if_suspect}            |
|                                 | [NEEDS REVIEW]    | First human response                   |                                |
|                                 | [NEEDS REVIEW]    | Mitigation actions taken               |                                |
|                                 | [NEEDS REVIEW]    | Resolution confirmed                   |                                |
|                                 | [NEEDS REVIEW]    | Full recovery + verification           |                                |

# Root Cause Analysis

- **Primary root cause** (technical + process): {hypothesis_description}
- **Contributing factors** (config drift, missing guardrails, capacity, code path): {alternative_hypotheses_as_contributing_factors}
- **Why it wasn't caught earlier** (gaps in tests/monitoring/reviews): {detection_gap_inference — e.g., "No Prometheus alert configured for {metric}" if trend detected in Step 3 but no firing alert in Step 2; or "ArgoCD drift unmonitored" if Step 4 found OutOfSync; or "[NEEDS REVIEW]" if no inference possible}
- **5 Whys**: {llm_generated_5_whys_chain_from_rca_or "[NEEDS REVIEW] Complete during post-mortem"}

**Supporting evidence:**
{evidence_keys_list}

**Diagnostic commands:**
{diagnostic_commands_list}

**Remediation steps:**
{remediation_steps_list}

# What Went Well

- **Detection** (signals that worked): {list_of_steps_that_fired — e.g., "Step 2 caught CrashLoopBackOff within 30m heartbeat", "Step 3 identified memory creep trend before OOM", "BetterStack alert triggered at T0"}
- **Response** (coordination, tooling, expertise): {bot_response_timeline — e.g., "RCA posted to Slack within {latency}s of detection, confidence {confidence}%"}
- **Mitigation** (effective actions): {auto_pr_summary_if_created_or "[NEEDS REVIEW] Describe mitigation actions taken"}

# What Didn't Go Well

- **Detection gaps**: {missing_signal_analysis — e.g., "No cert expiry monitoring (Step 6 not yet deployed)", "Prometheus trends unavailable (Step 3 timed out)", or list of steps that timed out/skipped}
- **Response gaps** (handoffs, comms, documentation): {response_gap_inference — e.g., "No human response in Slack thread within {hours}h of alert" if thread archival shows no human messages; or "[NEEDS REVIEW]"}
- **Mitigation gaps** (slow rollback, missing feature flags, unclear ownership): {mitigation_gap_inference — e.g., "No rollback performed despite bad_deploy hypothesis", "Auto-PR blocked by confidence threshold ({confidence}% < {threshold}%)"; or "[NEEDS REVIEW]"}

# Action Items

| Action                              | Owner          | Linear Ticket |
| ----------------------------------- | -------------- | ------------- |
| {auto_pr_action_if_applicable}      | morpho-sre bot | {pr_url}      |
| {remediation_action_1_from_rca}     | [NEEDS REVIEW] |               |
| {remediation_action_2_from_rca}     | [NEEDS REVIEW] |               |
| {monitoring_gap_action_if_detected} | [NEEDS REVIEW] |               |

# Appendices

- **Relevant links**: {slack_thread_permalink}, {pr_url_if_any}, {grafana_dashboard_links}, {betterstack_incident_url_if_bs_triggered}
- **Supporting data**: evidence_completeness: {pct}%, triage latency: {total_latency_ms}ms, mode: {mode}
- **Related incidents**: {pattern_detection_results_or "No matching pattern in last 30 days"}

<details>
<summary>Full evidence bundle (Steps 1-10)</summary>

{truncated_evidence_summary}

</details>

{degradation_note_if_any}
```

- **HTML comments at top** contain machine-readable metadata for idempotency searches (`incident_id:{id}`) — not rendered in Linear UI but searchable via API
- **`[NEEDS REVIEW]`** markers indicate sections where the bot lacked sufficient data — the on-call engineer should fill or override these during the post-mortem
- **PR link:** If auto-fix PR created, add PR URL as a Linear link attachment
- **Slack thread link:** Add Slack thread permalink as a Linear link attachment
- **RCA version updates — append-only strategy with retention cap:** The bot never overwrites the existing ticket description wholesale. Instead:
  1. Extract **only the RCA sections** (Root Cause Analysis, Evidence, Diagnostic Commands) from the current description — not the entire description (which would include prior collapsed snapshots, creating nested duplication and superlinear growth)
  2. Snapshot the extracted RCA sections into a collapsed block: `<details><summary>RCA v{n-1} (superseded)</summary>{previous_rca_sections}</details>`
  3. Append the collapsed block to the Appendices section
  4. Replace the RCA sections in-place with the new version, preserving all other sections (header, human edits, Appendices, metadata) untouched
     This avoids nested duplication while preserving human edits. The human's additions to non-RCA sections (e.g., custom notes in the post-mortem) are never displaced.
     **Retention policy:** Keep the last 3 historical versions inline in the description. When a 4th version would be appended:
  5. Move the oldest collapsed version (v{n-4}) to a Linear **comment** on the ticket: `Archived RCA v{n-4} (moved from description to stay within size limits)`
  6. Remove the collapsed block from the description
     This keeps the description within the 30000-char Linear cap even for long-running incidents. The full history remains accessible via ticket comments. If the description still exceeds 25000 chars after retention cleanup, truncate the evidence bundle in the Appendices with `... truncated ({n} lines omitted)` until within budget.

#### Pattern Detection

- When creating a ticket, search Linear for similar incidents in Platform team from last 30 days (match on `canonical_category` + namespace + impacted services)
- If 3+ similar incidents found: add a "Recurring Pattern" section to the description:

```markdown
## Recurring Pattern

**Frequency:** {count} similar incidents in last 30 days
**Common signals:** {shared_canonical_category}, {shared_services}
**Previous tickets:** {PLA-XXX}, {PLA-YYY}, {PLA-ZZZ}
**Recommendation:** {systemic_fix_suggestion}
```

- Add `Technical debt` label alongside existing labels
- Add `Improvement` label if the pattern suggests a config or capacity fix

### Slack Thread Archival

**Trigger:** When the bot posts a triage alert to a Slack incident thread.

**Collection — incremental archival:**

- **Primary trigger:** On incident resolution (state file row moves to `resolved-incidents.tsv`). Collect all messages since thread creation.
- **Timeout trigger:** If the incident is still active after 4h, perform an **incremental archive pass** — collect messages since thread creation (or since last archive pass), summarize, and append to the Linear ticket as an interim comment: `Resolution Context (interim — incident still active, {elapsed}h)`. Subsequent incremental passes run every 4h while the incident remains active. On final resolution, a complete archive pass runs and replaces the interim comments with the definitive "Resolution Context" comment. **Idempotency strategy:** Each archival comment includes a stable HTML marker: `<!-- archival:{incident_id}:{pass_type} -->` where `pass_type` is `interim` or `final`. Before posting, search the ticket's comments for an existing comment with the same marker. If found, **edit** the existing comment in-place (Linear API update). If not found, create a new comment. On final resolution, find and edit all `interim` comments to prepend `(Superseded by final resolution context)` — do not delete them (preserves audit trail). This prevents duplicate archival comments across retries and crash recovery.
- **Filter:** Skip bot messages, keep all human messages (no character minimum — short messages like "rollback done", "fixed", "DNS" carry high signal in incident threads).
- **Summarize** key debugging insights using the bot's default LLM (Codex).

**Storage:** Append to the Linear ticket as a "Resolution Context" comment:

```markdown
## Resolution Context (from Slack thread)

### Human debugging insights:

- @engineer1: "The Redis connection pool was exhausted because the new deployment doubled the connection count"
- @engineer2: "Rolled back to v1.2.3, confirmed fix at 14:32 UTC"

### Timeline:

- 13:45: Alert triggered
- 13:52: First human response
- 14:15: Root cause identified
- 14:32: Rollback confirmed
```

**Future benefit:** When the bot searches Linear for similar incidents, these human annotations are included in search results, providing richer context for RCA.

### Redaction Contract

All data passes through the existing `sanitize_signal_line` scrubber (sentinel-triage.sh) **before** any Slack or Linear write. Additionally, new signal sources must comply:

**Scrubber patterns (applied to all output fields):**

- Bearer/auth tokens: `authorization: bearer <redacted>`
- Slack tokens: `xox[baprs]-<redacted>`, `xapp-<redacted>`
- GitHub tokens: `gh[pousr]_<redacted>`, `github_pat_<redacted>`
- AWS keys: `AKIA<redacted>`, `ASIA<redacted>`
- Anthropic keys: `sk-ant-<redacted>`
- Vault tokens: `hvs.<redacted>`, `s.<redacted>`
- Generic secret patterns (all formats — key=value, JSON, YAML):
  - Key-value: `password=<redacted>`, `secret=<redacted>`, `token=<redacted>`, `api_key=<redacted>`, `aws_secret_access_key=<redacted>`
  - JSON: `"password":"<redacted>"`, `"secret":"<redacted>"`, `"token":"<redacted>"`, `"api_key":"<redacted>"`, `"aws_secret_access_key":"<redacted>"` (matches `"key": "value"` with optional whitespace)
  - YAML: `password: <redacted>`, `secret: <redacted>`, `token: <redacted>`, `api_key: <redacted>`, `aws_secret_access_key: <redacted>` (matches `key: value` at line start or after indent)
  - Regex pattern: `(?i)(password|secret|token|api_key|aws_secret_access_key|private_key|client_secret)\s*[:=]\s*["']?[^\s"',}{]{4,}` → replace value with `<redacted>`
- Base64-encoded cert/key material: any base64 blob >40 chars in cert/secret output → `<redacted-cert-data>`
- Multiline/tabs normalized
- **Per-field truncation:** Individual signal lines (pod status, event messages, log snippets) are truncated to 220 chars each — this is per-line, not per-message. The 220-char limit bounds individual evidence fields to prevent a single noisy log line from dominating the output. The assembled Slack message body is separately capped at 3000 chars (see Max payload below). Mandatory sections (Summary, Root Cause, Blast Radius) are preserved first; evidence details and diagnostic commands are truncated last if the total exceeds the cap.

**Classification boundary:**

- **Allowed in Slack/Linear:** metric values, pod names, namespace names, error class names, alert names, container states, image tags, commit SHAs, PR URLs, diagnostic commands (read-only only — enforced via allowlist: `kubectl get|describe|logs|top|auth can-i`, `curl -s` GET-only, `aws ... describe|list|get` **with service-level deny list** (see below). Any command containing mutating verbs (`delete|patch|apply|create|edit|replace|scale|rollout|exec|run|cp|drain|cordon|taint`) is stripped before output)
- **AWS service-level deny list:** Even read-only AWS commands are denied for services/subcommands that return secret material or auth tokens: `secretsmanager get-secret-value`, `secretsmanager get-random-password`, `ssm get-parameter` (with `--with-decryption`), `ssm get-parameters` (with `--with-decryption`), `ssm get-parameters-by-path` (with `--with-decryption`), `kms decrypt`, `kms generate-data-key`, `kms generate-data-key-without-plaintext`, `sts get-session-token`, `sts assume-role` (returns temporary credentials), `sts get-federation-token`, `eks get-token`, `ecr get-login-password`, `ecr get-authorization-token`, `codeartifact get-authorization-token`, `codecommit get-repository-credentials`, `rds generate-db-auth-token`, `redshift get-cluster-credentials`, `lambda get-function` (returns pre-signed URL to code), `sso get-role-credentials`. Any diagnostic command matching these patterns is rewritten to a metadata-only equivalent (e.g., `aws secretsmanager describe-secret --secret-id {name}` for existence check, `aws eks describe-cluster` instead of `eks get-token`) or stripped entirely if no safe equivalent exists. The deny list is checked **before** the general read-only allowlist — a command must pass both the verb allowlist AND the service deny list to be emitted.
- **Never in Slack/Linear:** secret values, cert private keys, token strings, environment variable dumps, Vault lease content, decoded secret data, base64 payloads
- **Diagnostic commands scrub:** any diagnostic command targeting secret resources (`kubectl get secret`, `kubectl describe secret`, `kubectl get secret -o jsonpath=...`, `kubectl get secret -o go-template=...`, or any command with `secret` as the resource kind and an output flag other than `--show-labels`) is rewritten to metadata-only: `kubectl get secret {name} -n {ns} --show-labels` (existence check, no content). Also scrub: shell pipelines containing `base64 -d` or `base64 --decode` on secret output, and any `kubectl exec` command that reads secret files (e.g., `cat /var/run/secrets/...`)

**Enforcement — dual-boundary scrubbing:**

1. **Pre-LLM input (Step 11 prompt assembly):** The evidence bundle is scrubbed before being sent to any LLM provider (Codex or Claude). This prevents secret material from reaching external model APIs. Step 0 Linear search results and Slack thread archival context are also scrubbed before inclusion in the prompt.
2. **Pre-external-write (Slack/Linear):** The scrubber runs as the final step before `chat.postMessage` and Linear API calls. LLM output (Step 11) is also scrubbed — the LLM may hallucinate secret-like strings in diagnostic commands.
   Both boundaries use the same `sanitize_signal_line` scrubber with identical patterns.

**Max payload:** Slack message body capped at 3000 chars (Slack limit: 4000, leave headroom). Linear description capped at 30000 chars. Evidence bundle in collapsed block is truncated with `... truncated ({n} lines omitted)` if exceeded.

### Slack Output Contract

Incident thread payload (single structured message, not multi-model attribution):

```markdown
## Incident: {brief_description}

**Severity:** {level} | **Confidence:** {merged_confidence}% | **RCA v{rca_version}** | **Evidence:** {evidence_completeness_pct}%

### Root Cause Analysis

{top_hypothesis_description}

**Supporting evidence:**

- {evidence_1}
- {evidence_2}

**Diagnostic commands:**

- `{command_1}`
- `{command_2}`

### Alternative Hypotheses

{hypothesis_2_brief} (confidence: {n}%)
{hypothesis_3_brief} (confidence: {n}%)

### Blast Radius

{affected_services_and_user_impact}

### Remediation

{recommended_steps}

### Pattern Analysis

{recurrence_info_or_none}

{degradation_note_if_any}
{pr_recommendation_if_applicable}
```

### Optional PR Lane

Integrates with existing `autofix-pr.sh` infrastructure.

**Mode-specific gates:**

| Gate                  | Single-model                            | Dual-model (initial)                                                                                                                                                                         | Dual-model (graduated)                    |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Confidence threshold  | `merged_confidence` >= 90%              | `merged_confidence` >= 85%                                                                                                                                                                   | `merged_confidence` >= 85%                |
| Convergence gate      | N/A                                     | **Must have converged** (canonical contract satisfied — not just `agreement_score` threshold). Non-converged reports (Codex-primary fallback) are **never PR-eligible** regardless of score. | Same — convergence required               |
| Agreement score       | N/A                                     | `agreement_score` >= 0.6 (Jaccard) — redundant with convergence but explicitly checked as defense-in-depth                                                                                   | `agreement_score` >= 0.6                  |
| Human acknowledgment  | **Required** (ack/thumbs-up within 15m) | **Required** (same as single)                                                                                                                                                                | Not required (dual agreement substitutes) |
| Evidence completeness | `evidence_completeness` >= 0.7          | `evidence_completeness` >= 0.6                                                                                                                                                               | `evidence_completeness` >= 0.6            |

**Dual-mode graduation:** Human ack remains required in dual mode until the dual-mode PR lane meets a safety KPI: 30+ PRs created with <5% rollback-or-closed-as-wrong rate. Until then, dual mode only lowers the confidence threshold and adds the agreement gate — it does not remove the human checkpoint. Graduation is a manual operator decision logged as `DUAL_PR_GRADUATED=true`.

**Common gates (both modes):**

- Existing policy gates pass: risk tier, file allowlist, secret scan, repo allowlist
- DM to PR approver(s) before PR creation: **blocking** when human ack is required (single-model and dual-initial — PR is not created until ack/thumbs-up within 15m, no response = no PR); **informational** (non-blocking) only in dual-graduated mode. **Approver set:** env `PR_APPROVER_SLACK_IDS` (comma-separated Slack user IDs in `U...` format, **required** — no default; PR lane is disabled if unset). DM is sent to all listed approvers; first ack from any approver unblocks. If no approvers are reachable (all DMs fail), PR is blocked with alert to `#staging-infra-monitoring`.
- DM to PR approver(s) after PR URL posted (always, all modes)
- Never auto-merge/deploy

### Secret Management

**Single-model mode (Codex):** Uses existing OpenAI/Codex credentials already configured in `carapulse-secrets` and the deploy script. No new secrets required.

**Dual-model mode (Codex + Claude) — Anthropic API key wiring (Phase 6b only):**

- Local dev: `claude.txt` file (same pattern as `slack.txt`, `grafana.txt`, `betterstack.txt`). Deploy script reads it, never logs key material.
- Cluster: `anthropic-api-key` added to `carapulse-secrets` contract. Injected as `ANTHROPIC_API_KEY` env var at pod startup.
- Validation: deploy script **gates all Anthropic checks on `RCA_MODE=dual`**. When `RCA_MODE=single` or `heuristic`, the script skips `claude.txt` reading, `ANTHROPIC_API_KEY` injection, format checks, and API probes entirely — missing key is not an error. When `RCA_MODE=dual`: format check (starts with `sk-ant-`) blocks deploy if invalid; API probe is warning-only (bot starts in degraded Codex-only mode, does not block pod readiness).
- Rotation: same process as other secrets — update `carapulse-secrets`, redeploy.

### Daily Cost Health Report (Separate from Incident Pipeline)

**Script:** `aws-cost-report.sh`

Runs on a daily cron (08:00 UTC), not during incident triage.

**Queries:**

- AWS Cost Explorer: current month spend vs. previous month (daily granularity)
- Top cost contributors by service
- Anomaly detection: >20% increase from previous period

**Output:** Structured digest posted to `#staging-infra-monitoring`:

```markdown
## Daily Cost Report — {date}

**MTD Spend:** ${current} (prev month: ${previous}, delta: {+/-}%)
**Top services:** {service_1} ${amount}, {service_2} ${amount}
**Anomalies:** {anomaly_description_or_none}
```

Not linked to incident severity scoring. Informational only.

---

## Implementation Phases

All signal expansion phases ship first. LLM processing upgrades follow. This ensures the evidence pipeline is rich before we optimize how it's synthesized.

### Phase 1: Prometheus Metric Trends + Cron Trigger Fallback

- New script: `prometheus-trends.sh`
- Integrate as Step 3 in sentinel-triage.sh with 10s timeout + skip-on-timeout
- Add trend signals to severity scoring input
- **Cron trigger fallback (Slack SPOF mitigation):** Add a Kubernetes CronJob (`openclaw-sre-heartbeat-cron`) that runs the triage pipeline on a 30m schedule independent of Slack. Output written to PVC spool dir (`${INCIDENT_STATE_DIR}/spool/`). **Pre-Phase-5 dedup:** Before Phase 5 introduces stable `incident_id`, the cron and Slack paths deduplicate via a lightweight content hash: `dedup_key = sha256(namespace + primary_category + workload_hash8 + date_hour_half)` where `workload_hash8` is the same hash used for incident_id (or `empty000` sentinel), and `date_hour_half` is the date+hour rounded to 30m buckets (`:00` or `:30`) to match the heartbeat cadence — this prevents two different incidents in the same hour from being deduped together. **`evidence_fingerprint` is intentionally excluded** from the dedup key because it is volatile — concurrent cron and Slack runs may collect slightly different evidence (race on log collection, Prometheus query timing) and compute different fingerprints for the same outage. Including it would defeat dedup. The fingerprint is used only for RCA versioning (same fingerprint → no RCA update needed). **Flapping/recurrence within same bucket:** If an incident resolves and the same signals reappear within the same 30m bucket, the dedup key collides. This is acceptable pre-Phase-5 (over-grouping is the safer failure mode). The spool coalescing logic posts only the latest snapshot, so the on-call sees the most recent triage. Post-Phase-5, stable `incident_id` with explicit resolve/reopen lifecycle replaces this coarse dedup entirely. The spool file is named `triage-{dedup_key}-{ts}.json`. **Early lease (before Step 11):** After computing the `dedup_key` (pre-Phase-5) or `incident_id` (post-Phase-5) from the evidence gathered in Steps 0-10 but **before** running Step 11 (LLM RCA), the triage pipeline acquires an atomic lease to prevent duplicate LLM calls. **Pre-check: always check `.done` first.** Before attempting `mkdir`, check if the `.done` marker already exists for this work unit: pre-Phase-5 `${INCIDENT_STATE_DIR}/spool/{dedup_key}.done`; post-Phase-5 `${INCIDENT_STATE_DIR}/spool/{incident_id}-v{rca_version}.done`. If `.done` exists → skip Step 11 unconditionally (another run already completed the LLM call and wrote the spool payload). **Spool marker contract (two markers, two purposes):** `.done` = Step 11 completed and spool payload is durable on disk. Written immediately after spool file `fsync`. Used by the lease pre-check to prevent duplicate LLM calls. `.ack` = delivery confirmed (outbox transitioned to `sent`). Written when the Slack/Linear POST succeeds. Used by the spool lifecycle for cleanup. The lease directory is retained until `.done` is written (not `.ack`), since delivery may fail and require retries — the lease only needs to prevent duplicate LLM runs, not duplicate delivery attempts. This covers the non-concurrent case where a previous run completed, posted, and cleaned up its lease dir — without this check, a subsequent run would see no lease dir and re-acquire the lease despite the work being done. **Lease acquisition uses atomic `mkdir`** (POSIX guarantees `mkdir` fails if the directory already exists — no TOCTOU race): `mkdir ${INCIDENT_STATE_DIR}/spool/lease-{key}` where `{key}` is the `dedup_key` or `incident_id`. If `mkdir` succeeds → this run owns the lease, proceed to Step 11. Write an ownership token file inside the lease dir: `{hostname}:{timestamp_epoch}` (hostname identifies the pod, timestamp enables TTL). If `mkdir` fails (EEXIST) → check: if a `.done` marker exists for this key → another run already completed Step 11, skip entirely. If no `.done` → read the ownership token from the lease dir; if the timestamp is within the TTL (5 minutes), another run is in-progress — skip Step 11. If the timestamp exceeds the TTL, the lease is considered abandoned (crashed writer). **Lease cleanup:** On Step 11 completion (success or failure), write the `.done` marker (spool payload is durable), then remove the ownership file and `rmdir` the lease directory. This eliminates the race window where the lease is released but no `.ack` exists — without this, a concurrent run arriving in that gap would see no lease and no `.ack`, re-run Step 11, and produce a duplicate LLM call. Stale leases (ownership token timestamp > 5 minutes old with no spool output) are reclaimed by the next triage run — `rm` the ownership file + `rmdir` the lease dir, then re-attempt `mkdir` to acquire. This works across pod boundaries (no PID check — PIDs are meaningless across cron pod and main pod which run in different PID namespaces). This prevents duplicate LLM calls when cron and Slack fire in the same window. Both cron and Slack-triggered runs compute the same key for identical evidence — the atomic lease ensures at most one LLM invocation per dedup window. **Phase 5 upgrade:** When Phase 5 lands, `dedup_key` is replaced by `incident_id` and spool filenames switch to `triage-{incident_id}-{ts}.json`. The coalescing and lifecycle rules below apply identically to both key schemes. **Spool posting atomicity:** Before posting a spool file to Slack, acquire an exclusive `flock` on `${INCIDENT_STATE_DIR}/spool/post.lock`. Under the lock: (1) check if an `.ack` marker file exists for this key **at this version** — **pre-Phase-5:** `${INCIDENT_STATE_DIR}/spool/{dedup_key}.ack` (per-key, no version — acceptable because dedup_key includes `date_hour_half` bucket). **Post-Phase-5:** `${INCIDENT_STATE_DIR}/spool/{incident_id}-v{rca_version}.ack` (per-key-per-version). The post-Phase-5 format ensures that an `.ack` for `v1` does NOT suppress posting of `v2` when evidence evolves and the RCA is updated within the same incident. If the matching `.ack` exists, release lock and skip. (2) Coalesce: find all spool files for the same key (and same version post-Phase-5), pick the latest timestamp, silently mark older files as acked. (3) Post the selected file to Slack. (4) On success, create the `.ack` marker file and rename the spool file to `.acked`. (5) Release lock. This prevents concurrent cron + Slack-triggered runs from both posting for the same key/version even though they create different-named spool files, while allowing legitimate RCA version bumps to be posted. **Spool lifecycle:** Acked files and `.ack` markers older than 24h are deleted. Un-acked spool files are **not independently retried** — the outbox state machine (state file columns) is the single source of truth for retry tracking. The spool is the payload store only. On each heartbeat, the outbox logic checks `slack_post_status`/`linear_post_status`: if `pending` or `failed_retryable`, it reads the corresponding un-acked spool file and attempts the POST (incrementing outbox attempts). After `MAX_ATTEMPTS=3` total failures, the outbox transitions to `failed_terminal` and alerts. The spool file is acked (`.ack` marker written) only when the outbox transitions to `sent`. If a spool file exists but the outbox already shows `sent` (crash between POST success and `.ack` write), reconcile: write the `.ack` marker under flock. Un-acked spool files with no corresponding incident in the state file (orphaned after state corruption/rebuild) are promoted to `.dead` after 24h. Spool dir is capped at 100 files total — oldest un-acked files are promoted to `.dead` if the cap is reached. **Durability limitation:** The spool provides best-effort durability, not guaranteed delivery. During a prolonged Slack outage (>3 heartbeat cycles for a given incident, or >100 total un-acked files), triage results may be dead-lettered. The state file preserves incident context regardless — when Slack recovers, the next heartbeat's RCA (with the latest evidence) is posted normally. Dead-lettered files contain historical RCA snapshots that can be retrieved from PVC for forensics but are not automatically replayed. This is an acceptable trade-off: the latest RCA (posted on recovery) is always more useful than stale historical snapshots.
- Test: verify queries return data, validate trend detection thresholds, verify timeout/skip behavior
- Test: cron trigger fires independently of Slack, verify dedup with Slack-triggered run
- Test: cron+Slack concurrent race — both fire within the same heartbeat window, verify exactly one spool file posted (`.ack` prevents duplicate), second run is a no-op
- Test: spool lifecycle — verify `.ack` rename on delivery confirmation, `.done` marker on Step 11 completion (see spool marker contract), 24h TTL cleanup of acked files, `.dead` promotion for orphaned spool files (no matching incident in state file after 24h), 100-file cap enforcement
- Test: redaction regression suite — verify all scrubber patterns:
  - Token prefixes: `Bearer xyz`, `xoxb-...`, `ghp_...`, `AKIA...`, `sk-ant-...`, `hvs....`
  - Key-value formats: `password=secret123`, `"token":"abc"`, `token: abc123`
  - Regex catch-all: `aws_secret_access_key=LONG_VALUE`, `"private_key":"..."`, `client_secret: value`
  - Diagnostic command scrub: `kubectl get secret -o yaml`, `kubectl describe secret`, `kubectl get secret -o jsonpath=...`, pipelines with `base64 -d`
  - Pre-LLM input boundary: verify evidence bundle is scrubbed before LLM prompt assembly
  - False-positive check: pod names, metric values, namespace names must NOT be redacted
- Test: spool per-key dedup — cron and Slack trigger simultaneously for same dedup_key, create different-named spool files (different timestamps). Verify per-key `.ack` marker prevents both from posting. Verify only the latest-timestamp file is posted.
- Note: outbox crash-window idempotency, silent-skip vs 30m digest, and Linear preflight retry tests are deferred to Phase 5 (which introduces the outbox state machine, incident identity, and Linear ticketing). Phase 1 tests focus on: Prometheus trends, cron trigger independence, spool dedup, spool lifecycle, redaction, and early lease.

### Phase 2: ArgoCD Sync & Drift

- New script: `argocd-sync-status.sh`
- Integrate as Step 4 in sentinel-triage.sh with 5s timeout + skip-on-timeout
- Requires: ArgoCD token configured (already in carapulse-secrets)
- Test: verify drift detection against intentional out-of-sync state

### Phase 3: Cert & Secret Health

- New script: `cert-secret-health.sh`
- Integrate as Step 6 in sentinel-triage.sh with 5s timeout + skip-on-timeout
- Vault checks conditional on VAULT_ADDR being set
- Test: create test certs with near-expiry dates

### Phase 4: AWS Resource Signals + Daily Cost Report

- New script: `aws-resource-signals.sh` (runtime-impacting only, 8s timeout)
- New script: `aws-cost-report.sh` (daily cron, not in incident pipeline)
- Integrate resource signals as Step 7 in sentinel-triage.sh
- Wire cost report to separate daily cron posting to Slack
- Requires: AWS CLI access (already available via IAM role)
- Test: verify node health checks, verify cost report formatting

### Phase 5: Linear Incident Memory

- Implement Linear entity preflight: lazy, non-fatal — resolve and cache IDs for team (Platform), project (Infrastructure Backlog), 2 required labels (`Bug`, `Monitoring`), and 6 optional labels (`ai-ready`, `Security`, `Alerting`, `Devops`, `Technical debt`, `Improvement`) on first ticket-worthy incident (not at startup). On missing required entity: set `LINEAR_AVAILABLE=false`, skip ticketing, log warning, retry on every subsequent ticket-worthy heartbeat (severity >= MEDIUM) while `LINEAR_AVAILABLE=false`, throttled to at most once per 5 minutes. This ensures ongoing incidents get tickets once Linear recovers, not just new incidents. On missing optional label: log warning, omit label from tickets, ticketing continues.
- Add Linear MCP tool calls to SKILL.md instructions
- Implement Step 0: pre-triage search with 5s timeout (match current signals against past incidents)
- Implement persistent incident state file (`active-incidents.tsv`) on PVC with flock + atomic rename writes
- Implement `incident_id` generation (BetterStack-sourced: `bs:{id}` with `bs:thread:{ts}` fallback; heartbeat-sourced: `hb:{ns}:{primary_category}:{first_seen_ts}:{workload_hash8}` with `primary_category` locked on first pass, `first_seen_ts` from state file, `workload_hash8` = first 8 hex of SHA-256 of sorted pod prefixes at first detection, or sentinel `empty000` when workload list is empty)
- Implement continuity matcher for incident matching (see "Matching logic" in Incident Identity for canonical definition):
  - **Exact match:** namespace + category + `last_seen_ts` within 120m staleness bound + workload overlap (≥1 shared prefix when both sides non-empty; skipped when either side empty).
  - **Continuity match:** namespace + different category + time ≤60m (always required) + dimension-dependent overlap thresholds per the normative pseudocode (see "Normative continuity match pseudocode" in Incident Identity). When both dimensions available: workload Jaccard ≥50% AND signal key Jaccard ≥30%. When one dimension empty: the other's threshold is raised (signal key → ≥50%, workload → ≥70%). When both empty: no continuity match possible.
  - **Multi-incident routing:** exact (single) → route; exact (multiple, current non-empty) → highest workload Jaccard similarity; exact (multiple, current **empty**) → reuse existing `empty000`-sentinel incident if still ambiguous (stored workloads still empty) and active, tie-break by most recent `last_seen_ts` then oldest `first_seen_ts`; if no qualifying sentinel → create one new ambiguous incident with `empty000` hash; all ambiguous-empty paths emit `incident_id_ambiguous_empty_workload` metric; no exact but continuity candidates → weighted score (workload×0.5 + signal×0.3 + recency×0.2, all 0–1 Jaccard-normalized); no match → tier 4 new incident.
  - **Staleness auto-resolve:** rows with `last_nonempty_ts` >120m (standard) or either forced trigger (`last_seen_ts` >240m OR `last_nonempty_ts` >240m) are auto-archived after matching (see Staleness auto-resolve section in Incident Identity).
- Implement post-triage ticket creation with two-layer idempotency (local state file primary with flock + atomic rename, Linear API search as fallback for state loss)
- Implement post-mortem description template (Eng Post-Mortem format — all sections bot-filled, `[NEEDS REVIEW]` where data insufficient)
- Implement pattern detection (3+ similar incidents in 30 days → tech debt)
- Test: Linear preflight — verify missing label triggers degradation (not crash), verify `LINEAR_AVAILABLE=false` skips ticketing while triage continues
- Test: create test incidents, verify search accuracy, verify dedup prevents duplicate tickets on recurring heartbeats, verify same outage with drifting signals (category flip) stays one ticket via continuity matcher
- Test: concurrent same-category incidents in same namespace — two `resource_exhaustion` incidents affecting disjoint non-empty workloads (e.g., `api-server` vs `worker`) must produce separate `incident_id`s and separate tickets. Verify exact match fails (zero overlap, both non-empty), continuity match is inapplicable (same category), so tier 4 applies → new incident
- Test: state file atomicity — verify flock prevents concurrent corruption, verify atomic rename survives kill -9 mid-write
- Test: stale auto-resolve — create active incident, advance clock past 120m, then trigger a new heartbeat (with non-empty workloads). The heartbeat's matching pass scans active rows and finds the stale row. Verify: row moved to archive with `stale_timeout` reason, Linear comment posted (not status change) with correct `{elapsed}` value, Slack thread closure message posted, `incident_stale_timeout` metric emitted. (Note: auto-resolve runs during the matching pass of an arriving heartbeat — it requires a heartbeat to trigger the scan, it is not a background sweeper.)
- Test: forced stale auto-resolve during telemetry gap — create active incident receiving only empty-workload keep-alives so `last_seen_ts` advances but `last_nonempty_ts` stalls. Advance `last_nonempty_ts` beyond 240m while keeping `last_seen_ts` <240m. Trigger heartbeat. Verify forced closure with `stale_timeout_forced` (trigger b), Slack/Linear closure comments, and metric emission.
- Test: same-minute same-category ID uniqueness — create two `resource_exhaustion` incidents in same namespace within same minute but with disjoint workloads, verify `workload_hash8` suffix produces distinct `incident_id`s
- Test: empty-workload continuity — create incident with empty `affected_workloads` (no discoverable pods), fire 3 subsequent same-category heartbeats also with empty workloads, verify all match the same `incident_id` (workload check skipped when either side empty). Also verify `workload_hash8` is sentinel `empty000` in the ID.
- Test: empty-to-populated workload transition — create incident with empty workloads, second heartbeat has workloads `[api-server]`, verify match (empty-side skip), verify workloads populated. Third heartbeat with same category but `[worker]` (disjoint, both non-empty), verify exact match fails (zero overlap), continuity match inapplicable (same category), tier 4 → new incident.
- Test: populated-to-empty clobber guard — create incident with workloads `[api-server|redis]`, second heartbeat has empty workloads (discovery failure), verify match (empty-side skip), verify stored workloads NOT overwritten (still `[api-server|redis]`). Third heartbeat with `[worker]` (disjoint, both non-empty), verify exact match fails and tier 4 → new incident (proving the clobber guard preserved dedup integrity).
- Test: ambiguous-empty multi-match — create two active same-category incidents in one namespace (e.g., `resource_exhaustion` with workloads `[api-server]` and `[worker]`). Fire heartbeat with **empty** workloads and same category. Verify: both candidates match via empty-side skip, but routing does NOT pick by recency — instead creates (or reuses) a single `empty000`-sentinel incident. Fire a second empty heartbeat, verify it routes to the **same** `empty000` incident (no churn). Verify `incident_id_ambiguous_empty_workload` metric emitted for each empty heartbeat.
- Test: continuity match with empty workloads (category drift during discovery outage) — create incident with category `resource_exhaustion` and empty workloads. Fire heartbeat with different category `config_drift`, empty workloads, but ≥50% signal key overlap with stored keys. Verify continuity match succeeds (empty-side exception applies, raised signal threshold met). Fire another heartbeat with different category, empty workloads, but only 35% signal key overlap (below raised 50% threshold). Verify continuity match fails → tier 4 new incident.
- Test: sentinel recovery disqualification — create `empty000`-sentinel incident, then update it with non-empty workloads `[api-server]` (simulating recovery). Fire a new empty heartbeat with >1 exact candidates. Verify the now-concrete sentinel is NOT reused (stored workloads non-empty → no longer qualifies as ambiguous) — a fresh `empty000` incident is created instead.
- Test: multiple sentinel tie-break — manually create two active `empty000`-sentinel rows for the same namespace+category with different `last_seen_ts`. Fire empty heartbeat. Verify routing picks the sentinel with the most recent `last_seen_ts`. If tied, verify oldest `first_seen_ts` wins.
- Test: outbox crash-window idempotency — simulate crash after successful Slack POST but before status update to `sent`. Verify next heartbeat retries POST. Verify duplicate message is benign (same content in same thread). Verify `chat.update` path uses persisted `message_ts` when available.
- Test: outbox version race (stale writer guard) — run two concurrent workers for same incident: worker A posts `v2`, worker B bumps to `v3` before A finalizes. Verify A's finalize path sees `row.rca_version != target_rca_version` and does not mark `sent`/overwrite attempts. Verify `v3` remains `pending` and is posted.
- Test: silent-skip vs 30m digest — create incident, first heartbeat posts RCA v1. Second heartbeat with same fingerprint: verify no RCA update posted (silent skip), but 30m digest keep-alive line IS posted to Slack thread. Verify no Linear ticket update on digest-only heartbeat.
- Test: Linear preflight retry on ongoing incident — simulate Linear outage on first heartbeat (severity MEDIUM), verify `LINEAR_AVAILABLE=false` and no ticket. Simulate Linear recovery on second heartbeat (same incident, same severity), verify preflight retries and ticket is created for the ongoing incident.

### Phase 6a: Single-Model LLM RCA (Codex)

- Add `RCA_MODE` env var to deploy script and Helm values
- Replace heuristic hypothesis generation in sentinel-triage.sh with Codex LLM call (uses existing OpenAI/Codex credentials — no new secrets required)
- Build prompt template requiring structured JSON output (hypothesis_id + canonical_category + evidence_keys)
- Implement unified output schema with `incident_id`, `evidence_fingerprint`, `rca_version`, `evidence_completeness`
- Implement conditional trigger (incident-only, skip healthy heartbeats)
- Add graceful fallback to heuristic scoring (15s timeout)
- Wire Slack output to new structured format with RCA versioning
- Implement evidence completeness gate (require Step 1+2; enrichment minimum of one of 3/4/5/6/7/10; cap confidence at 50% if all enrichment steps fail). Dynamic denominator: `applicable_steps` based on configured prerequisites.
- Implement RCA update policy (same `incident_id` + changed fingerprint → version bump; different `incident_id` → new thread)
- Implement single-mode PR guard: confidence >= 90%, evidence completeness >= 0.7, mandatory human `ack` via Slack DM before PR creation (15m timeout, no ack = no PR)
- Test: compare LLM RCA quality against heuristic output on historical incidents
- Test: evidence completeness gate — verify "insufficient evidence" output when Step 1 or 2 fails
- **Measure:** track human acceptance rate via Slack reactions over first 50 reviewed incidents (unreviewed excluded from rate, weekly nudge if >40% unreviewed). Log per-incident: mode, latency, confidence, reaction, completeness.

### Phase 6b: Dual-Model RCA (Codex + Claude) — CONDITIONAL

- **Gate (advisory):** The bot recommends proceeding if Phase 6a severity-weighted acceptance rate is <80% (upper bound of 90% bootstrap CI) after 50+ reviewed incidents. Activation requires explicit operator action (`RCA_MODE=dual` in deploy config) — the gate is advisory, not automatic. The operator may also override with `RCA_MODE=dual` manually even if the gate is not triggered, subject to the preconditions listed in the Activation Criteria section.
- Add Anthropic secret wiring: `claude.txt` + `carapulse-secrets` contract (`anthropic-api-key`) + deploy script ingestion
- Deploy validation: format check blocks deploy; API probe is warning-only (no readiness gate)
- Add `ANTHROPIC_API_KEY` injection to Helm deployment template (`deploy/eks/charts/openclaw-sre/templates/deployment.yaml`)
- Implement parallel Claude call (secondary) with same structured JSON prompt/schema (same canonical taxonomy)
- Implement iterative cross-review loop: Round 0 (parallel investigation) → Round 1-2 (cross-review with peer's RCA + revision prompt)
- Implement convergence check after each round using the canonical convergence contract: ALL of same `canonical_category` AND same `hypothesis_id` AND Jaccard >= 0.6 AND `|A ∩ B|` >= 2. Round 0: these 4 conditions suffice (`agree_with_peer` not available). Round 1+: additionally both `agree_with_peer: true`.
- Implement weak convergence rejection: same `canonical_category` but different `hypothesis_id` → NOT converged (prevents false agreement from relaxing PR safety gates)
- Implement merge logic on convergence (richer evidence_keys as primary, averaged confidence, Jaccard as `agreement_score`)
- Implement non-convergence fallback after Round 2 (Codex-primary, 20% confidence penalty, flagged for human review)
- Implement Jaccard-based `agreement_score` on `evidence_keys` (`|A ∩ B| / |A ∪ B|`, empty set → 0)
- Populate `model_metadata` (including `review_notes`, `review_rounds`), `agreement_score` in output schema
- Implement runtime downgrade/recovery state machine files: `${INCIDENT_STATE_DIR}/rca-convergence-stats.tsv` + `${INCIDENT_STATE_DIR}/rca-mode-state.tsv` under flock, with 7d downgrade gate (>30%, >=10 samples), 14d recovery gate (<15% or <10 samples), and 1/day probe execution while downgraded
- Implement dual-mode PR gate (single checkpoint, all conditions checked together — see "Optional PR Lane" table for canonical definition):
  1. **Convergence required** — report must have converged via canonical contract (non-converged Codex-primary fallbacks are never PR-eligible)
  2. `agreement_score` >= 0.6 (Jaccard — defense-in-depth, redundant with convergence)
  3. `merged_confidence` >= 85%
  4. `evidence_completeness` >= 0.6
  5. Human ack required until graduation (30+ PRs, <5% rollback rate)
     All five conditions are AND-gated. Failure of any one blocks PR creation.
- Test: all four degradation modes (both ok, Claude-only, Codex-only, neither)
- Test: runtime downgrade/recovery hysteresis — force `rate_7d > 30%` with >=10 samples, verify effective mode forced to single; then force `rate_14d < 15%` (or <10 samples), verify automatic re-enable to dual
- Test: agreement vs. disagreement scenarios with known-good incident data
- Test: same root cause with different `hypothesis_id` but same `canonical_category` → correctly classified as NOT converged (weak convergence rejection)
- Test: same `hypothesis_id` + same `canonical_category` + Jaccard >= 0.6 + overlap >= 2 + both agree → correctly classified as converged

### Phase 7: Slack Thread Archival

- Monitor threads where bot posts alerts
- Collect human messages on resolution/timeout (4h)
- Summarize and append to Linear ticket
- Test: simulate incident thread, verify collection and summarization

### Phase 8: Metrics & Experiment Rollout

- Track per-incident: RCA mode, latency per step, total latency, confidence, human acceptance, step timeouts/skips
- Dashboard: RCA quality over time, model availability, degradation frequency, per-step timeout rates
- If dual-model activated: track agreement scores, measure whether dual improves over single
- Daily cost report delivery tracking

---

## Repo-Fit Notes (Practical Gaps to Address)

These are known gaps between the current codebase and this design:

- **Helm/deploy wiring:** `deploy/eks/charts/openclaw-sre/templates/deployment.yaml` currently includes OpenAI/Codex env vars but not `ANTHROPIC_API_KEY`. Phase 6b (dual-mode) must add this. Phase 6a (single/Codex) uses existing credentials.
- **Triage script:** `deploy/skills/morpho-sre/scripts/sentinel-triage.sh` has no `RCA_MODE` / dual-lane logic. Phase 6a must add the mode switch and LLM call; Phase 6b adds the second lane.
- **No per-step timeout infrastructure:** Current sentinel-triage.sh runs steps sequentially without individual timeouts. Phase 1 should introduce the timeout + skip-on-timeout pattern that all subsequent phases reuse.
- **No structured JSON output from triage:** Current output is TSV sections. The LLM RCA step (Phase 6a) consumes TSV as input but produces JSON as output. The Slack formatter must bridge both formats.
- **No incident identity system:** Current triage uses `incident_fingerprint` in the gate file (`incident-gate.tsv`) which is a volatile signal hash. Phase 1 introduces a lightweight `dedup_key` (`sha256(namespace + primary_category + workload_hash8 + date_hour_half)` — see Phase 1 for canonical formula; `evidence_fingerprint` intentionally excluded because it's volatile across concurrent runs) for cron/Slack dedup. Phase 5 replaces this with stable `incident_id` generation and migrates the gate file to use it.
- **BetterStack incident ID extraction:** The BetterStack alert thread handler needs to extract the incident/check ID from the thread context and pass it to the triage pipeline for `bs:{id}` identity generation. Fallback: if extraction fails, use `bs:thread:{slack_thread_ts}` and log `incident_id_source=bs_thread_fallback`.

---

## Success Criteria

- Bot detects slow-burn issues (resource creep, cert expiry) before they cause outages
- RCA quality improves: human operators agree with top hypothesis >80% of the time (measured via Slack reactions over 50+ incidents, severity-weighted)
- Recurring incidents are automatically surfaced as tech debt in Linear
- No duplicate incident tickets for the same `incident_id` under normal operation (the Linear API eventual-consistency window may produce a rare duplicate — see Post-Triage Ticket Creation for the dedup-then-close mitigation; the KPI target is ≤1 duplicate per 100 incidents)
- Healthy heartbeat latency stays under 30s
- Incident heartbeat with single-model LLM synthesis stays under 50s (with per-step timeouts)
- Incident heartbeat with dual-model synthesis: p95 under 75s (converge by Round 1); p99 under 119s (Round 2 + step timeouts)
- Per-step timeout skip rate <10% (if higher, investigate infrastructure)
- No false positive rate increase (signal-to-noise ratio improves or stays constant)
- No secret exposure in logs/messages
- Single-lane degraded mode completes without outage
- Optional PR lane: >=85% valid PR creation in low-risk scope. **Valid PR** = merged within 7 days AND no revert commit or follow-up fix PR within 7 days of merge. PRs closed without merge count as invalid. PRs still open after 7 days are excluded from the metric until resolved.
- Daily cost report delivered by 08:15 UTC

## Operational Answers

**Q: Where is authoritative incident state stored for cross-heartbeat and post-restart continuity?**
A: PVC-backed state file at `${INCIDENT_STATE_DIR}/active-incidents.tsv` (same volume as existing `incident-gate.tsv`). Contains 21 columns: `incident_id`, `namespace`, locked `primary_category`, `first_seen_ts`, `last_seen_ts`, `last_nonempty_ts` (staleness clock for non-empty-workload heartbeats), `rca_version`, `evidence_fingerprint`, `evidence_signal_keys` (structured key list for continuity matching overlap), `linear_ticket_id`, `slack_thread_ts`, `affected_workloads` (pod prefixes for continuity matching), `category_drift_log` (append-only record of classifier changes), `slack_post_status`, `slack_post_attempts`, `linear_post_status`, `linear_post_attempts` (outbox columns for reliable external writes), `linear_reservation` (two-phase ticket creation marker), `bs_alias` (BetterStack alias for heartbeat-detected incidents), `last_primary_ts` (last time incident was primary routing target), `non_primary_streak` (consecutive non-primary heartbeats). Survives pod restarts. Accessed by both the main pod and cron fallback pod via flock serialization. See "Incident state persistence" in the Incident Identity section.

**Q: What is the atomic dedup primitive for Linear ticket creation?**
A: Exclusive `flock` + write-to-temp + `fsync` + atomic `mv` rename on the shared PVC state file. The flock serializes concurrent writes from both the main pod and the cron fallback pod (two-writer model). The atomic rename guarantees readers see either old or new state (never partial). PVC must support concurrent access (ReadWriteMany or same-node scheduling). Linear API search is a fallback for state file loss, not the primary dedup mechanism. See "Concurrency model" and "Idempotency" in Post-Triage Ticket Creation.

**Q: What explicit redaction contract exists before Slack/Linear writes?**
A: All output passes through `sanitize_signal_line` scrubber before any external write. Extended with Anthropic key, Vault token, and base64 cert patterns. Classification boundary defines what's allowed vs forbidden. Max payload caps enforced. See "Redaction Contract" section.

**Q: What rollback plan if Linear/Slack APIs degrade but triage must continue?**
A: Triage and detection are fully independent of external APIs. Linear degradation: ticketing skipped, `LINEAR_AVAILABLE=false`, retry on every subsequent ticket-worthy heartbeat (severity >= MEDIUM) while `LINEAR_AVAILABLE=false`, throttled to at most once per 5 minutes. Slack degradation: the bot runs inside Slack (OpenClaw gateway with socket mode) — if Slack is down, the bot can't receive heartbeat triggers at all (Slack IS the trigger transport). Mitigation: **local cron fallback (launch requirement, Phase 1)** — a Kubernetes CronJob runs the triage pipeline on a 30m schedule independent of Slack. Output is spooled to PVC (`${INCIDENT_STATE_DIR}/spool/triage-{dedup_key}-{ts}.json`, upgraded to `triage-{incident_id}-{ts}.json` after Phase 5). When Slack connectivity resumes, the bot reads pending spool files, coalesces per key (post only the latest, silently ack older snapshots), and posts. Spool lifecycle: `.ack` marker on successful post, 24h TTL for acked files, 3 retries for un-acked, `.dead` promotion on exhaustion, 100-file cap to prevent unbounded PVC growth. The cron trigger and Slack trigger are deduplicated via the spool directory — if both fire for the same heartbeat window, the second one sees an existing `.ack` marker for the same `dedup_key` (pre-Phase-5) or `incident_id`-v`rca_version` (post-Phase-5) and is a no-op for the same version. A new `rca_version` gets a fresh `.ack` key, allowing updated RCAs to be posted. Concurrency between cron pod and main pod is serialized via flock on the shared state file (see "Concurrency model" in Post-Triage Ticket Creation).

## Non-Goals

- Cluster mutations (rollbacks, restarts, scaling) — stays read-only
- Production cluster support (dev-only for now)
- Multi-cluster federation
- Custom Grafana dashboard creation
- PagerDuty/OpsGenie integration
- Free-text LLM debate or unstructured model disagreement resolution (cross-review uses structured JSON with convergence criteria)
- Exposing per-model attribution in Slack output (internal detail only)
- Real-time cost signals in the incident pipeline (cost is daily report only)
