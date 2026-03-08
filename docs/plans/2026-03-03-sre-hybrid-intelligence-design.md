# SRE Bot Hybrid Intelligence — Design Document

**Date**: 2026-03-03
**Status**: Approved (v20 — post Codex review rounds 1-19, critical fixes merged)
**Builds on**: 2026-03-02-sre-bot-deep-signals-design.md
**Review**: v1→v2: 7C/8H; v2→v3: 3C/10H; v3→v4: 3C/7H/3M; v4→v5: 5H; v5→v6: 3H; v6→v7: 1C/3H/4M/1L; v7→v8: 1C/2H/2M/1L; v8→v9: 3H/2M/1L; v9→v10: 4H/2M/1L; v10→v11: 1C/3H/1M; v11→v12: 2H/4M; v12→v13: 3H/2M/1L; v13→v14: 2C/4H; v14→v15: 1C/5H; v15→v16: 1C/8H; v16→v17: 1C/7H; v17→v18: 6H; v18→v19: 3C/5H (design-vs-code delta); v19→v20: 4C/2H (structured category handoff, cluster-safe suggestion keys, realistic deadline budgets, fail-closed sink redaction)

**Scope note**: This document is a **design specification** for features to be implemented across Phases 1-4. Code references to existing scripts (sentinel-triage.sh, lib-rca-llm.sh, etc.) describe the integration points where new code will be added. New constructs (chain orchestrator, incident memory, evidence bundle expansion, outbound redaction, instruction-token stripping, RCA skip logic) do not exist in the codebase yet — they are the implementation targets of this design.

## Problem

The SRE bot has a solid 12-step evidence pipeline and incident state management, but the LLM synthesis step produces shallow RCAs. Specific failure modes:

1. **Shallow RCAs** — identifies WHAT is wrong but not WHY (says "pod OOM" but doesn't trace to the memory leak in the latest deploy)
2. **Missed connections** — has all evidence pieces but fails to synthesize causal chains
3. **Generic recommendations** — textbook advice ("check resource limits") instead of specific actions ("review commit abc123 in api-gateway v2.4.0")
4. **Incomplete solutions** — misses edge cases, rollback implications, blast radius across dependent services

## Goal

Evolve the bot from "evidence collector with a summary" to "Staff SRE that reasons about your specific services." The bot should produce:

- **Causal chains with confidence**: trigger → propagation → symptoms, with evidence at each step
- **Differential diagnosis**: multiple hypotheses ranked with supporting/contradicting evidence
- **Ranked action plans**: immediate mitigation → root cause fix → preventive measure, each with blast radius and rollback path

## Approach: Hybrid Intelligence (Three Layers)

Three layers on top of the existing 12-step sentinel-triage pipeline:

```
┌─────────────────────────────────────────────────────────┐
│                    EXISTING PIPELINE                     │
│  Steps 0-10: Evidence Collection (K8s, Prometheus,       │
│  logs, certs, AWS, repos, CI)                           │
└──────────────────────┬──────────────────────────────────┘
                       │ raw evidence
                       ▼
┌─────────────────────────────────────────────────────────┐
│              LAYER 1: SERVICE KNOWLEDGE                  │
│  Auto-Discovery + Operational Overlays + Incident Memory │
└───────────────────────┬─────────────────────────────────┘
                       │ service context
                       ▼
┌─────────────────────────────────────────────────────────┐
│           LAYER 2: REASONING CHAIN                       │
│  Triage → Hypothesize → Causal Chain → Action Plan       │
│  → Cross-Review                                         │
└───────────────────────┬─────────────────────────────────┘
                       │ structured RCA + actions
                       ▼
┌─────────────────────────────────────────────────────────┐
│           LAYER 3: INCIDENT LEARNING                     │
│  Incident cards + Overlay suggestions + Feedback signals │
└─────────────────────────────────────────────────────────┘
```

**Incremental deployment**: Each layer improves RCA quality on its own. However, Layer 2 reasoning quality is significantly better with Layer 1 context. Ship Layer 1 first, measure improvement, then add Layer 2. Layer 3 (incident learning) works with both chain and legacy output — it extracts incident cards from whatever JSON `run_step_11()` returns. With chain output, cards are richer (causal chain, ranked hypotheses). With legacy single-shot output, cards are partial (`card_type: "partial"`) containing the required partial-card fields defined in Layer 1c (card_id, triage_incident_id, card_type, namespace, cluster, service, date, category, severity, rca_confidence, evidence_fingerprint — all extractable from top-level JSON + runtime context). **Config guard**: `INCIDENT_LEARNING_ENABLED=1` is valid with either `RCA_CHAIN_ENABLED=0` or `1`; no hard dependency.

---

## Layer 1: Service Knowledge

Three sources merge into a unified service context document that feeds every RCA.

### 1a. Auto-Discovery

Runs as a new triage step (before LLM synthesis). Produces a topology snapshot using a **tiered discovery model** — each tier is optional and the graph degrades gracefully:

| Tier               | Source                    | What it extracts                                   | Availability               |
| ------------------ | ------------------------- | -------------------------------------------------- | -------------------------- |
| T1 (always)        | K8s labels/annotations    | service name, team, tier, namespace                | All clusters               |
| T1 (always)        | K8s service selectors     | which deployments back which services              | All clusters               |
| T1 (always)        | Deploy manifests env vars | references to other services (DB hosts, API URLs)  | All clusters               |
| T1 (always)        | ConfigMaps/Secrets refs   | shared config dependencies                         | All clusters               |
| T2 (if Prometheus) | Prometheus metrics        | request rate, error rate, latency between services | Clusters with Prometheus   |
| T3 (if mesh)       | NetworkPolicy / Istio     | service-to-service call edges                      | Clusters with service mesh |

**Graceful degradation**: T1 sources are always available and provide namespace-scoped service catalog + env-var-inferred dependencies. T2 adds traffic-based edges. T3 adds mesh call graph. Missing tiers produce a partial graph (not a failure).

Output: `service-graph.json` — adjacency list with **fully qualified service names** (`namespace/service`) to prevent ambiguity across namespaces. Edges typed as `calls`, `depends-on`, `shares-config`, with `discovery_tier` provenance:

```json
{
  "cluster": "dev-morpho",
  "generated_at": "2026-03-03T14:30:00Z",
  "discovery_tiers": ["t1", "t2"],
  "services": {
    "production/api-gateway": {
      "namespace": "production",
      "team": "platform",
      "tier": "critical",
      "depends_on": [
        { "service": "production/auth-service", "edge_type": "calls", "discovery_tier": "t2" },
        { "service": "production/redis-cache", "edge_type": "depends-on", "discovery_tier": "t1" }
      ],
      "depended_by": [
        { "service": "production/web-frontend", "edge_type": "calls", "discovery_tier": "t2" }
      ]
    }
  }
}
```

Runs once per heartbeat cycle (30m), cached to PVC via **flock + atomic replace** (acquire lock, write to temp file, fsync, rename — same `_state_with_lock` + `_state_atomic_replace` pattern as state files) to prevent both torn reads and stale-overwrite races during concurrent heartbeat/cron execution. The CronJob `concurrencyPolicy: Forbid` already prevents parallel cron runs, but flock guards against overlapping heartbeat + cron execution. **Actual API cost**: 3-5 kubectl calls (get deployments, get services, get configmaps with label selectors, optionally get networkpolicies) + 1-3 Prometheus range queries (if T2 enabled). Total: ~5-10s.

### 1b. Operational Overlays

Per-service YAML files in the skills bundle (deployed via ConfigMap):

```yaml
# service-overlays/api-gateway.yaml
service: api-gateway
namespace: production
cluster: dev-morpho # cluster-qualified to prevent ambiguity across clusters
owners:
  primary: "@alice"
  escalation: "@platform-oncall"
known_failure_modes:
  - id: oom-under-load
    pattern: "OOMKilled + request_rate > 500/s"
    root_cause: "unbounded request body buffering"
    remediation: "scale to 4 replicas, then apply memory limit patch"
    rollback: "revert to previous image tag"
  - id: cert-expiry
    pattern: "TLS handshake failure + cert expires < 24h"
    root_cause: "cert-manager renewal failed"
    remediation: "kubectl delete certificate && wait for renewal"
safe_operations:
  - "horizontal scale (2-6 replicas)"
  - "restart pods (rolling)"
unsafe_operations:
  - "delete PVC (data loss)"
  - "force image rollback (breaks if schema migration ran)"
resource_baseline:
  cpu_normal: "200m-400m"
  memory_normal: "256Mi-512Mi"
  memory_oom_threshold: "480Mi"
```

**When no overlay exists**: The bot still works — auto-discovered topology provides dependency context, and the reasoning chain operates on raw evidence without service-specific knowledge. Stage D action plans will cite causal chain evidence instead of known remediations (see Stage D fallback behavior in Layer 2).

### 1c. Incident Memory

Restructures the existing Linear memory lookup into structured incident cards:

```json
{
  "card_id": "hb:production:resource_exhaustion:20260215T1402:a3f8b2c1",
  "triage_incident_id": "hb:production:resource_exhaustion:fp:d4e5f6a7:abc123",
  "card_type": "full",
  "namespace": "production",
  "cluster": "dev-morpho",
  "service": "api-gateway",
  "affected_workloads": ["api-gateway-7b5f8c9d4", "api-gateway-6a4e7b8c3"],
  "date": "2026-02-15",
  "category": "resource_exhaustion",
  "severity": "high",
  "root_cause_summary": "memory leak in v2.3.1 request parser",
  "trigger": "deploy of api-gateway:v2.3.1 at 14:02",
  "propagation_path": ["memory growth", "OOMKill", "service unavailability"],
  "fix_applied": "rollback to v2.3.0",
  "permanent_fix_pr": "#847",
  "time_to_detect_min": 45,
  "time_to_mitigate_min": 12,
  "evidence_fingerprint": "d4e5f6a7",
  "rca_confidence": 85,
  "rca_model": "codex",
  "rca_prompt_version": "v2",
  "tags": ["oom", "deploy-triggered", "memory-leak"],
  "lessons": ["No memory limit was set", "Load tests don't cover /upload"]
}
```

**`incident_id` composition**: The **triage pipeline's** `incident_id` (used in `active-incidents.tsv`, state files, and alert routing) is built **before** Step 11 using the heuristic category and existing format (`hb:{namespace}:{heuristic_category}:fp{fingerprint}:{workload_hash}`). This ID is immutable within a triage cycle and must not depend on LLM output. The **incident memory card** uses a separate `card_id` for memory storage: format `hb:{namespace}:{canonical_category}:{first_seen_ts}:{evidence_hash_8}`. The `canonical_category` component uses the LLM-derived value (available after Step 11). The `first_seen_ts` uses the incident's first-seen time (not card creation time) to prevent duplicate IDs across re-runs. The `evidence_hash_8` is the first 8 hex chars of the `evidence_fingerprint`. **Linkage**: The incident card stores the triage pipeline's `incident_id` as a cross-reference field (`triage_incident_id`), enabling joins between the memory store and the live triage state.

**Card types**: `card_type` is `"full"` (chain A-D+ with causal chain and action plan) or `"partial"` (A-B only, low severity, or legacy single-shot). Partial cards require only: `card_id`, `triage_incident_id`, `card_type`, `namespace`, `cluster`, `service`, `date`, `category`, `severity`, `rca_confidence`, `evidence_fingerprint`. All other fields are optional and omitted when the RCA didn't produce them.

**Field mapping note**: The incident card stores **both** category sources to prevent split-brain:

- `category` (authoritative): extracted from Step 11 JSON `canonical_category` field. Used as the primary key for memory lookup and storage.
- `heuristic_category`: extracted from the pre-Step11 `step11_dedup_category`. Used for routing/dedup cross-reference.

**Category reconciliation rule (intentional dual-authority)**: Two category sources serve different purposes by design:

- **`category`** (LLM-derived `canonical_category`): authoritative for incident memory storage/lookup and incident cards. Represents analyzed root cause.
- **`heuristic_category`** (pre-Step11 `step11_dedup_category`): authoritative for routing/dedup (`primary_category` in cron output). Represents fast pre-LLM classification.

This dual authority is intentional: routing decisions must be made before Step 11 runs (can't wait for LLM), while memory lookup benefits from LLM analysis. When the two disagree, the incident card stores both. The broad pre-Stage-B lookup (`cluster:namespace:service`) returns all cards regardless of category, so historical incidents are found even when sources disagree. The `category_drift_log` field in active-incidents.tsv tracks disagreements for observability.

**Lookup keys (two-phase)**:

- **Pre-Stage-B lookup** (broad): `cluster:namespace:service` — retrieves all incident cards for the service regardless of category. This feeds into Stage B as context for hypothesis generation (before `canonical_category` exists).
- **Post-resolution storage key** (precise): `cluster:namespace:service:category` — the full key used when writing incident cards after resolution. Also used for targeted re-lookup in later chain stages if needed (not for the initial service context assembly — that uses the broad key).

Both keys are fully qualified with `cluster` (set from `$K8S_CONTEXT` at write time) to prevent collision across clusters sharing the same namespace/service. **Selection rule for multiple matches**: return up to 5 entries within the last 90 days, sorted by date descending (most recent first). **Note on retention vs retrieval**: Incident cards are retained up to 365 days (Critical/High) per the severity-weighted eviction policy, but the 90-day retrieval window for RCA context is intentional — older incidents are less relevant for active triage. Retained data beyond 90 days serves non-RCA purposes: postmortem reports, trend analysis, and the feedback loop (tracking whether fixes held). The retrieval window may be expanded in Phase 4 for recurring pattern detection.

**Storage**: `incident-memory.jsonl` on PVC, one line per resolved incident. **Concurrency**: All writes use flock + atomic replace (same pattern as `lib-state-file.sh` `_state_with_lock` / `_state_atomic_replace`). **Redaction**: The entire JSON line is passed through `_rca_prompt_scrub()` as a single string before writing — this applies regex-based scrubbing across all fields. Note: scrubbing is best-effort and may not catch novel secret formats (same limitation as prompt scrubbing). Structured fields like `affected_workloads` (pod names, not user input) are inherently low-risk.

**Retention** (severity-weighted eviction):

| Severity | Base retention | Max age  | Eviction priority                        |
| -------- | -------------- | -------- | ---------------------------------------- |
| Critical | 180 days       | 365 days | Last (never evict before lower severity) |
| High     | 180 days       | 365 days | Last                                     |
| Medium   | 90 days        | 180 days | After low                                |
| Low      | 60 days        | 90 days  | First                                    |

Hard cap: 500 entries. When cap reached, evict lowest-severity oldest entries first.

### Merged Service Context Block

At RCA time, the reasoning chain receives:

```
=== SERVICE CONTEXT: api-gateway (production) ===
Team: platform (@alice, escalation: @platform-oncall)
Tier: critical
Dependencies: auth-service (calls, t2), redis-cache (depends-on, t1)
Depended by: web-frontend (calls, t2)
Resource baseline: CPU 200-400m, Memory 256-512Mi (OOM at ~480Mi)

Known failure modes:
  1. OOM under load (pattern: OOMKilled + high request rate)
     → Scale to 4 replicas, then apply memory limit patch

Past incidents (last 90d):
  - 2026-02-15: OOM from memory leak in v2.3.1 (fixed in PR #847)
  - 2026-01-20: OOM from unbounded connection pool (fixed in PR #792)

=== EVIDENCE (steps 1-10 output) ===
...
```

**Prompt-injection mitigation for incident memory**: When injecting past incident cards into the service context block, only a strict field allowlist is included: `date`, `category`, `severity`, `root_cause_summary`, `fix_applied`, `permanent_fix_pr`. Free-text fields that could carry attacker-controlled content (`lessons`, `tags`, full `propagation_path` descriptions) are excluded from the prompt. Additionally, all injected field values are truncated to 200 characters and stripped of instruction-like patterns **anywhere in the text** (not just line-start) — matching tokens: `You are`, `Ignore previous`, `System:`, `Assistant:`, `<|`, `[INST]`, `</s>`. The stripping removes the entire line containing any matched token. For L3 auto-remediation decisions, incident memory context is informational only — the gate checks (`known pattern`, `overlay match`, `blast-radius`) are evaluated against the current overlay YAML and live evidence, not against memory-stored text.

**Service context assembly timing**: The merged service context block (including "Past incidents") is assembled BEFORE the reasoning chain starts, using the **broad pre-Stage-B lookup** (`cluster:namespace:service` — no category filter). This means all past incidents for the service are included regardless of category, giving Stage B full context for hypothesis generation. The category-filtered key (`cluster:namespace:service:category`) is used only at write time (when storing new incident cards after resolution) and for targeted re-lookup in later stages if needed.

---

## Layer 2: Multi-Stage Reasoning Chain

### Output contract: backward-compatible

The 5-stage chain is implemented **inside** `run_step_11()` — it replaces the internal logic of lib-rca-llm.sh but produces the **same required core fields** that downstream consumers expect, plus additive new fields (`mode` already exists in legacy output via `_llm_attach_mode`; `chain_metadata` is new and ignored by existing consumers):

```json
{
  "severity": "high",
  "canonical_category": "resource_exhaustion",
  "summary": "...",
  "root_cause": "...",
  "hypotheses": [...],
  "rca_confidence": 85,
  "mode": "chain_v2",
  "chain_metadata": {
    "stages_completed": ["A", "B", "C", "D", "E"],
    "total_latency_ms": 45000,
    "evidence_triage": {...},
    "causal_chain": {...}
  }
}
```

Top-level fields (`severity`, `canonical_category`, `summary`, `root_cause`, `hypotheses`, `rca_confidence`) remain identical. The `rca_confidence` field (0-100) is derived from the top hypothesis confidence in chain mode and from the legacy heuristic confidence in single-shot mode. **`mode` field enum contract**: The `mode` field is an open string enum — existing consumers MUST treat unknown values as opaque (log and continue, not fail). Current values: `"single"`, `"dual"`, `"heuristic"` (legacy). New values added by the chain: `"chain_v2"` (full chain), `"chain_v2_partial"` (short-circuited chain). The existing `_llm_attach_mode()` function already sets `mode` as a free-form string; no consumer in the codebase does strict enum matching (verified: cron extraction ignores `mode`, Linear ticket creation ignores `mode`, Slack formatting ignores `mode`).

**Critical migration: structured category handoff (Phase 2 blocker)**. The cron dedup/routing path MUST stop deriving `primary_category` from the human-readable `=== ranked_hypotheses ===` text section (free-text titles are unstable and can silently change dedup keys). Instead:

1. Read `primary_category` from structured triage payload (`step11_payload.primary_category`) first.
2. Use text-section parsing only as a temporary fallback with warning metric `meta_alert:legacy_category_parser_hit`.
3. Remove fallback after two stable releases with zero fallback hits.

This migration keeps backward-compat while removing a fragile coupling between presentation text and routing identity. Linear ticket creation (lib-linear-ticket.sh) continues reading Step 11 JSON via fallback jq paths (`.summary // .brief_description`, `.root_cause // .top_hypothesis.description`) that are satisfied by the chain output's top-level fields. New `chain_metadata` remains additive and ignored by existing consumers.

**Partial result contract**: When the chain short-circuits (severity-adaptive A/B only, timeout, or gate failure), the output MUST still include all required top-level fields. The chain assembler fills missing fields with safe defaults:

| Field                             | Partial-result default                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `severity`                        | From evidence signal counts (same as current heuristic)                                                                                                                                                                  |
| `canonical_category`              | From Stage B top hypothesis if available, else `"unknown"`                                                                                                                                                               |
| `summary`                         | Stage B description if available, else "Insufficient evidence for full analysis"                                                                                                                                         |
| `root_cause`                      | Stage C trigger if available, else `"[NEEDS REVIEW]"`                                                                                                                                                                    |
| `hypotheses`                      | Stage B output if available, else single entry: `{"hypothesis_id": "unknown:insufficient_evidence", "canonical_category": "unknown", "description": "Insufficient evidence for hypothesis generation", "confidence": 0}` |
| `rca_confidence`                  | Top hypothesis confidence if Stage B completed, else `0`                                                                                                                                                                 |
| `mode`                            | `"chain_v2_partial"` (distinguishes from full chain result)                                                                                                                                                              |
| `chain_metadata.stages_completed` | Lists only completed stages                                                                                                                                                                                              |

### Evidence bundle expansion

Current Step 11 receives mostly signal counters. The reasoning chain needs **raw step outputs**. The evidence bundle passed to `run_step_11()` is expanded to include `STEP_OUTPUT_01` through `STEP_OUTPUT_10` (sampled excerpts from each evidence collection step), not just the aggregated counts.

**Evidence sanitization**: Before inclusion in the evidence bundle, each `STEP_OUTPUT_*` is passed through `_rca_prompt_scrub()` for secret redaction, then instruction-like tokens **anywhere in the text** (not just line-start) are stripped — matching the same expanded token set used for incident memory sanitization: `You are`, `Ignore previous`, `System:`, `Assistant:`, `<|`, `[INST]`, `</s>`. The stripping removes the entire line containing any matched token. This ensures evidence and memory use identical sanitization logic (a shared `_strip_instruction_tokens()` helper). Note: evidence is inherently untrusted (it comes from kubectl, Prometheus, logs) and is injected into the LLM prompt as data, not instructions — each stage's system prompt explicitly delineates the evidence block as user-provided data.

**Size cap and truncation strategy**: Each `STEP_OUTPUT_*` is capped at **4KB** using a **head+tail** strategy: first 3KB + last 1KB, with a `[...truncated middle...]` marker. This preserves both initial context (resource names, timestamps) and tail content (error messages, stack traces) that often contain the decisive signal. Total evidence bundle ceiling: ~50KB (10 steps x 4KB + counters + metadata). This prevents LLM context blowout and keeps per-stage call cost bounded. The truncation happens in the evidence bundle construction (sentinel-triage.sh lines ~2350-2370), not in the collection steps themselves (raw outputs on disk remain full-size for debugging).

### Why multi-stage beats single-shot

Single-shot fails because: the LLM tries to do everything at once, irrelevant evidence dilutes signal, no structured hypothesis testing, no adversarial check (confirmation bias in a single pass).

### Stage A: Evidence Triage

- **Input**: Raw evidence (steps 1-10 full outputs) + service context
- **Job**: Classify each evidence piece as signal (relevant), noise (normal/irrelevant), or unknown
- **Output**: Filtered evidence with relevance scores
- **Gate**: Must retain >= 1 signal piece. If zero signals, chain stops here → output uses partial result contract with `mode: "chain_v2_partial"`, `stages_completed: ["A"]`, severity from heuristic, and `root_cause: "[NEEDS REVIEW] — insufficient evidence signals"`

### Stage B: Hypothesis Generation

- **Input**: Filtered evidence + service context + incident memory matches
- **Job**: Generate 3-5 ranked hypotheses, each with `hypothesis_id` (format `category:slug`), `canonical_category`, description, supporting evidence, contradicting evidence, confidence (0-100%), and similar past incident reference. The `hypothesis_id` and `canonical_category` fields are **required** — the chain output contract uses `canonical_category` from the top hypothesis to populate the top-level field, and the learning trigger excludes entries by `hypothesis_id`. (Routing category remains `step11_payload.primary_category` from pre-Step11 heuristic classification; hypothesis categories are for RCA semantics and memory lookup.)
- **Gate**: Top hypothesis must have >= 1 supporting evidence piece. If not, produce best-effort hypothesis with `confidence_capped: true` flag

### Stage C: Causal Chain Construction

- **Input**: Top 2 hypotheses + service graph (whatever tiers are available)
- **Job**: For each hypothesis, construct trigger_event → propagation (via dependency edges if known) → observed symptoms (mapped to evidence). If service graph has no dependency edges for this service, construct trigger → symptoms directly and flag `dependency_graph_unavailable: true`
- **Output**: Structured causal chains with timestamps
- **Gate**: Chain must link trigger → >= 1 observed symptom. Incomplete chains are flagged with explicit `gaps: [...]` array, not rejected

### Stage D: Action Plan

- **Input**: Top causal chain + service overlay (if exists)
- **Job**: Produce ranked actions: (1) IMMEDIATE — stop the bleeding, (2) ROOT CAUSE — fix underlying issue, (3) PREVENTIVE — stop recurrence. Each with blast radius, rollback path, specifics.
- **Gate (two-attempt)**: Each action must reference a known remediation from the overlay OR cite specific causal chain evidence. On first attempt, if actions are generic (no overlay match and no specific evidence citation), the stage retries once with an explicit "be specific" instruction. If the retry still produces generic actions, accept the retry output with `action_plan_quality: "generic"` flag — a generic action plan is better than no action plan, so the gate does not block the chain.

### Stage E: Cross-Review

- **Input**: Complete output from stages A-D
- **Job**: Cross-review pass (uses `RCA_STAGE_MODEL_STRONG`, same model as C/D — independence comes from the adversarial system prompt, not model diversity) validates — does the chain explain ALL symptoms? Contradicting evidence dismissed without justification? Actions safe per unsafe_operations list (if overlay exists)? Simpler explanation missed?
- **Output**: Validated RCA or revision notes
- **Gate**: Single-pass review with up to 1 revision loop (2 LLM calls max for Stage E). This is intentionally simpler than the existing dual-mode multi-round convergence — it validates one chain, not arbitrating two independent RCAs.

### Implementation and mode interactions

Each stage is a separate LLM call with a focused system prompt, implemented inside `lib-rca-llm.sh`. The `run_step_11()` function orchestrates A→B→C→D→(E) internally and returns the same JSON contract. A feature flag `RCA_CHAIN_ENABLED` (default `0`) controls whether the chain or legacy single-shot path runs, allowing gradual rollout.

**Critical: chain mode and dual mode are mutually exclusive.** When `RCA_CHAIN_ENABLED=1`, the chain's internal Stage E provides cross-review. The external `RCA_MODE=dual` loop in sentinel-triage.sh (which runs two `run_step_11()` calls + 3-round convergence) is **skipped** — sentinel-triage.sh checks `RCA_CHAIN_ENABLED` before entering the dual path. This prevents nested cross-review (chain-E inside dual-loop) which would cause 2x latency and 2x cost with inconsistent arbitration.

**Config validation**: On startup, `run_step_11()` checks for `RCA_CHAIN_ENABLED=1 && RCA_MODE=dual`. This combination emits a one-time warning to stderr: `"WARN: RCA_CHAIN_ENABLED=1 overrides RCA_MODE=dual — chain Stage E replaces external dual-mode convergence. Set RCA_MODE=single to suppress."` The warning is logged but does not block execution — the chain runs with Stage E cross-review. This makes the override explicit and auditable rather than silent.

```
RCA_CHAIN_ENABLED=0, RCA_MODE=single     → legacy single-shot (current behavior)
RCA_CHAIN_ENABLED=0, RCA_MODE=dual       → legacy dual-mode with external convergence (current behavior)
RCA_CHAIN_ENABLED=0, RCA_MODE=heuristic  → heuristic fallback, no LLM calls (current behavior)
RCA_CHAIN_ENABLED=1, RCA_MODE=single     → chain A→B→C→D→(E), dual loop skipped
RCA_CHAIN_ENABLED=1, RCA_MODE=dual       → chain A→B→C→D→(E), dual loop skipped (WARNING emitted; chain E replaces dual)
RCA_CHAIN_ENABLED=1, RCA_MODE=heuristic  → heuristic fallback, no LLM calls (heuristic always wins)
```

**Safety invariant**: `RCA_MODE=heuristic` always takes precedence — it guarantees zero LLM calls regardless of `RCA_CHAIN_ENABLED`. This is the escape hatch during LLM provider outages.

### Per-stage model routing

New environment variables for per-stage model selection:

| Variable                         | Default                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RCA_CHAIN_ENABLED`              | `0`                                 | Feature flag: `0`=legacy single-shot, `1`=chain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `RCA_LLM_TIMEOUT_MS`             | `15000`                             | **Existing variable** (lib-rca-llm.sh line 9). Single-shot LLM call timeout (ms). Also used as the initial budget minimum threshold: if computed chain budget `< RCA_LLM_TIMEOUT_MS`, both chain and single-shot are skipped → heuristic fallback. Must be >= `RCA_STAGE_TIMEOUT_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RCA_STAGE_MODEL_FAST`           | `""` (uses system default provider) | Provider name for stages A+B (triage, hypothesize). Independent of `RCA_MODE` which controls execution mode, not model identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RCA_STAGE_MODEL_STRONG`         | `""` (uses system default provider) | Provider name for stages C+D+E (causal chain, action plan, cross-review)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RCA_STAGE_TIMEOUT_MS`           | `10000`                             | Per-stage timeout (ms)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RCA_CHAIN_TOTAL_TIMEOUT_MS`     | `60000`                             | Total chain budget (ms) — used **only when `RCA_CHAIN_ENABLED=1`**. If exceeded, return best partial result. Default 60s leaves headroom within the corrected 240s cron deadline and 80s evidence cap. May be lowered (e.g., 30s for faster cycles with shallower results) but must not exceed `cron_deadline - evidence_budget - sink_budget - safety_margin`. **Not used in legacy mode**: when `RCA_CHAIN_ENABLED=0`, the initial budget check uses `RCA_LLM_TIMEOUT_MS` (existing variable, default 15s) as the only timeout — `RCA_CHAIN_TOTAL_TIMEOUT_MS` is ignored entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RCA_EVIDENCE_TOTAL_TIMEOUT_MS`  | `80000`                             | Aggregate timeout budget (ms) for Steps 0-10 when chain mode is enabled. When exceeded, skip remaining optional evidence steps and continue with partial evidence. Keeps chain runs inside cron deadline under slow upstream dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RCA_MIN_RERUN_INTERVAL_S`       | `3600`                              | Minimum seconds between re-runs when fingerprint is unchanged. A fingerprint change always triggers a re-run regardless of this interval. Default 3600s (1h) — intentionally longer than the 30m heartbeat cadence so unchanged incidents skip at least one heartbeat cycle. A 30m value would cause a re-run every cycle (interval always elapsed), defeating the purpose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RCA_CHAIN_COST_ALERT_THRESHOLD` | `750`                               | Max chain LLM calls per calendar day before auto-disabling chain mode. Default 750 (~$18-22/day at typical rates). **Sizing rationale**: worst-case is a persistent Critical/High incident with constantly changing fingerprint — 48 re-runs/day × 7 calls (max with D-retry + E) = 336 calls. Two such incidents = 672. Default 750 accommodates this without false-tripping, while still catching runaway loops (e.g., a bug causing infinite re-runs). In practice, RCA skip logic means stable incidents (unchanged fingerprint) re-run at most once per hour (~24 re-runs/day × 7 calls = 168 calls per incident), so typical daily usage is well under the threshold. State is tracked in the `chain-call-counter.tsv` file under `INCIDENT_STATE_DIR` as a single-line YYYY-MM-DD<TAB>count record; the counter resets when the stored date differs from the current UTC date. Writes use the `_state_with_lock` helper to prevent concurrent increment races between heartbeat and cron. When exceeded, the circuit breaker disables chain mode and emits a meta-alert. Manual reset: delete the counter file or set the threshold to 0 (unlimited). |

### Cost and latency

|                          | Calls (min/typical/max) | Time    | Cost        |
| ------------------------ | ----------------------- | ------- | ----------- |
| Current (single-shot)    | 1/1/1                   | ~15-30s | ~$0.03-0.08 |
| Chain: Critical/High     | 5/5/7                   | ~50-60s | ~$0.15-0.40 |
| Chain: Medium            | 4/4/5                   | ~40-50s | ~$0.12-0.30 |
| Chain: Low               | 2/2/2                   | ~15-25s | ~$0.03-0.10 |
| Chain: Info              | 1/1/1                   | ~10s    | ~$0.02-0.05 |
| Learning card extraction | 1/1/1                   | ~5-10s  | ~$0.02-0.05 |

Max calls per incident lifecycle: 7 (chain with Stage D retry + Stage E revision) + 1 (card extraction on resolution) = **8 calls**. Card extraction runs once on resolution, not every heartbeat.

**RCA skip for ongoing incidents**: Skip full RCA and reuse previous result (touch `last_seen_ts` only) when BOTH conditions are true: (a) `evidence_fingerprint` hasn't changed since last RCA, AND (b) the minimum rerun interval (`RCA_MIN_RERUN_INTERVAL_S`, default 3600s/1h) has not elapsed. **Precedence rule**: a fingerprint change always triggers a re-run regardless of interval. The interval only gates re-runs when the fingerprint is unchanged.

```
fingerprint_changed=true  → always re-run (interval ignored)
fingerprint_changed=false AND interval_elapsed=true  → re-run (stale result refresh)
fingerprint_changed=false AND interval_elapsed=false → skip (reuse previous result)
```

With default settings (1h interval, 30m heartbeat), an unchanged incident skips at least one heartbeat cycle before re-running RCA. This means a stable incident re-runs at most once per hour (~2 re-runs per heartbeat-day), not every cycle.

**Timeout budget and cron deadline (corrected)**: Existing step timeout defaults are 180-300s for multiple evidence steps, so an `activeDeadlineSeconds=180` budget is not safe. Chain rollout adds an explicit evidence budget and higher cron deadline.

Chain-mode budget controls:

- `RCA_EVIDENCE_TOTAL_TIMEOUT_MS=80000` hard cap for Steps 0-10 aggregate wall-clock (new).
- `RCA_CHAIN_TOTAL_TIMEOUT_MS=60000` hard cap for chain stages (existing in this design).
- If evidence budget is exhausted, skip remaining optional evidence steps and proceed with partial evidence (do not kill the run).
- Increase cron `activeDeadlineSeconds` from 120s to **240s**.

Budget breakdown (chain mode):

```
Evidence steps 0-10:  ≤80s (new aggregate cap)
Chain (A→B→C→D→E):    ≤60s (RCA_CHAIN_TOTAL_TIMEOUT_MS=60000)
Learning extraction:  ≤10s (only on resolution, most cycles skip)
Sink formatting/post: ≤15s (Slack/Linear/webhook formatting + writes)
Safety margin:        75s (= 240 - evidence - chain - learning - sink)
─────────────────────────────────
Total:                ≤165s (within 240s deadline)
```

Per-stage timeout: 10s. **Total chain budget: `RCA_CHAIN_TOTAL_TIMEOUT_MS` (default 60s) is the hard cap** — all stages, retries, and revision loops run within this envelope. The chain orchestrator tracks elapsed time; when remaining budget < `RCA_STAGE_TIMEOUT_MS`, the current stage is the last one attempted. Worst-case call accounting at the default 60s budget:

```
Policy: next stage starts only if remaining_budget >= RCA_STAGE_TIMEOUT_MS (10s)

Nominal path (no retries):   A(10s) + B(10s) + C(10s) + D(10s) + E(10s) = 50s  [10s remaining → done]
Stage D retry:               A(10s) + B(10s) + C(10s) + D(10s) + D-retry(10s) = 50s  [10s remaining ≥ 10s → E allowed]
Stage D retry + E:           A(10s) + B(10s) + C(10s) + D(10s) + D-retry(10s) + E(10s) = 60s  [0s remaining → done, no E revision]
Stage E revision (no D retry): A(10s) + B(10s) + C(10s) + D(10s) + E(10s) + E-rev(10s) = 60s  [0s remaining → done]
Stage D retry + E + E-rev:   Not possible — budget exhausted after 6th call (60s)
```

Max LLM calls within 60s budget: **6** (5 stages + 1 retry OR revision, never both). The 7-call max in the cost table accounts for clock skew where individual calls complete faster than 10s each.

If any stage times out, the chain returns the best partial result assembled so far (e.g., if Stage C times out, return Stage B hypotheses as the RCA with `mode: "chain_v2_partial"`). When `remaining_budget >= 0` but `< RCA_STAGE_TIMEOUT_MS`, no more stages are started — the chain returns its current partial result (this is the same behavior as the stage-start policy: "next stage starts only if `remaining_budget >= RCA_STAGE_TIMEOUT_MS`"). The chain budget is always: `min(RCA_CHAIN_TOTAL_TIMEOUT_MS, deadline − elapsed − 10s margin)`. With a 240s deadline and 80s evidence cap, the chain gets the full 60s budget in normal operation; it only shrinks when pre-chain work overruns the evidence cap due timeout/slow-path skew. **Budget threshold precedence**: Two thresholds apply at different scopes, and the variables used depend on `RCA_CHAIN_ENABLED`:

1. **Initial budget check** (before any LLM call): Computed budget must be `>= RCA_LLM_TIMEOUT_MS` (default 15s), otherwise heuristic fallback (zero LLM calls). This check is identical for both legacy and chain modes — it uses `RCA_LLM_TIMEOUT_MS` (the existing single-shot timeout) as the minimum. The computed budget formula differs: in legacy mode, `budget = cron_deadline - elapsed - 10s_margin` (no reference to `RCA_CHAIN_TOTAL_TIMEOUT_MS`); in chain mode, `budget = min(RCA_CHAIN_TOTAL_TIMEOUT_MS, cron_deadline - elapsed - 10s_margin)`. This ensures tuning `RCA_CHAIN_TOTAL_TIMEOUT_MS` cannot accidentally disable legacy single-shot.
2. **Inter-stage check** (chain mode only): Once the chain is running, the next stage starts only if `remaining_budget >= RCA_STAGE_TIMEOUT_MS` (default 10s). If remaining budget is 10-14s, the chain can start one more stage but would not have started if the initial budget had been that low. This is consistent: the initial check uses the higher threshold (15s) to ensure at least one full stage + safety margin; inter-stage checks use the lower threshold (10s) since the chain is already running and partial results are acceptable.

**Circuit breaker**: If the chain fails 3 consecutive times (across heartbeat cycles), automatically fall back to legacy single-shot for 1 hour before retrying chain mode. **Scope**: The failure counter is **global** (not per-service or per-incident) — it tracks consecutive failures across all chain invocations. This is intentional: the most common failure mode is LLM provider outage, which affects all incidents equally. A single successful chain run (any incident) resets the counter. A "failure" is defined as: Stage A returning zero output (not partial result — partial is success), LLM provider returning HTTP error or timeout for every stage attempted, or invalid JSON from the chain assembler. Partial results (chain short-circuit with valid JSON) and gate-based short-circuits are NOT failures — they are expected outcomes. Additionally, if chain LLM calls exceed `RCA_CHAIN_COST_ALERT_THRESHOLD` (default: 750 calls/calendar day, see config table), the circuit breaker auto-disables chain mode and emits a meta-alert to the operator. Call count is tracked in `${INCIDENT_STATE_DIR}/chain-call-counter.tsv` — a single-line `YYYY-MM-DD<TAB>count` file that resets when the date field differs from the current UTC date. Writes use flock (same `_state_with_lock` pattern) to prevent concurrent increment races.

### Severity-Adaptive Depth

**Severity enum normalization**: The canonical severity values are lowercase strings: `"critical"`, `"high"`, `"medium"`, `"low"`, `"info"`. All severity comparisons (gate checks, depth selection, cost breaker) normalize to lowercase before comparison. JSON output uses lowercase (e.g., `"severity": "high"`). Display/tables in this doc use title case for readability but implementation always normalizes.

**Target state (Phase 3+)** — during Phase 2, Stage E is not available; see Phase 2 cross-review gap note in the Roadmap section:

| Severity      | Stages (Phase 3+) | Phase 2 stages | Reasoning                                                        |
| ------------- | ----------------- | -------------- | ---------------------------------------------------------------- |
| Critical/High | A → B → C → D → E | A → B → C → D  | Full chain + cross-review (Phase 3+) / no cross-review (Phase 2) |
| Medium        | A → B → C → D     | A → B → C → D  | Full chain, skip cross-review                                    |
| Low           | A → B             | A → B          | Triage + hypotheses only                                         |
| Info          | A                 | A              | Signal vs noise filter only                                      |

**L3 override** (deterministic pre-check): After Stage B completes, the chain orchestrator evaluates whether L3 auto-remediation is a candidate. The pre-check is: `(severity == Low OR Medium) AND overlay_exists AND top_hypothesis.hypothesis_id slug matches any known_failure_modes[].id in the overlay`. The slug comparison extracts the portion after the colon from `hypothesis_id` (format `category:slug`) and compares it against overlay IDs (format `slug-only`, e.g., `oom-under-load`). Example: `hypothesis_id: "resource_exhaustion:oom-under-load"` → slug `oom-under-load` matches overlay `id: oom-under-load`. If all three conditions are true, the chain forces full A-E depth (overriding the severity-adaptive default above) so the `cross-review converged` gate in the L3 autonomy level can be satisfied. If the pre-check fails, the chain follows the default severity-adaptive depth (A-B for Low, A-D for Medium). This check runs exactly once per chain invocation, immediately after Stage B output is available.

**Predicate alignment (L3 pre-check vs L3 gate)**: The L3 pre-check (slug match) and the L3 gate `known pattern` predicate (Jaccard similarity) must be consistent. The pre-check uses exact slug match as a cheap, deterministic filter to decide depth — it is intentionally stricter than the Jaccard gate. If a hypothesis passes the slug pre-check, it will always satisfy the Jaccard gate (exact match implies Jaccard = 1.0). The converse is not true: a hypothesis can satisfy Jaccard >= 0.6 without matching the slug exactly. This is by design — the pre-check is a conservative gate for forcing Stage E depth (high cost), while the Jaccard gate at L3 decision time allows fuzzy matching against evidence. An incident that passes Jaccard but fails slug match will run at default depth (A-B for Low, A-D for Medium) and be ineligible for L3 auto-remediation because `cross-review converged` requires Stage E to have run.

### Output Format (Slack)

**Outbound redaction (all sinks)**: Before publishing RCA output to **any external sink** (Slack, Linear ticket, webhook), the entire formatted payload is passed through a two-stage scrub:

1. **Regex scrub**: `_rca_prompt_scrub()` removes known secret patterns (bearer tokens, Slack tokens, GitHub PATs, AWS keys, etc.).
2. **Entropy gate**: A high-entropy token heuristic scans for base64/hex strings > 20 chars that survived regex scrub. If any are detected, the field value is replaced with `[redacted: suspected secret]` and the incident is flagged for operator review via meta-alert.

This defense-in-depth matches the quarantine approach used for overlay suggestions (see Layer 3) and applies to all output sinks.

**Critical sink invariant (fail-closed)**: implement a single shared wrapper `redact_for_sink(payload, sink)` and make it the only allowed path before Slack post, Linear create/update, webhook dispatch, and weekly digest output. Direct sink writes are forbidden. If redaction fails or entropy scanner flags unresolved secrets, suppress delivery for that sink, mark `sink_status=quarantined`, and emit a meta-alert. This avoids partial adoption where one sink bypasses redaction.

```
*Incident RCA: api-gateway OOMKilled*
Confidence: 85% | Severity: High | Category: resource_exhaustion

*Root Cause (most likely):*
Deploy of api-gateway:v2.4.0 at 14:02 introduced unbounded
request body buffering in /upload endpoint. Memory grew from
baseline 380Mi to 512Mi over 45 minutes, triggering OOMKill.

*Evidence chain:*
  14:02  Deploy v2.4.0 rolled out (3/3 pods)
  14:15  Memory usage crosses 400Mi (Prometheus)
  14:32  First container restart (K8s events)
  14:47  OOMKilled on all 3 pods (pod state)

*Alternative hypothesis:*
Noisy neighbor on node i-0abc (15%) — contradicted by
memory growth being container-scoped, not node-scoped.

*Similar past incident:*
2026-02-15: Same service, same pattern. Fixed by PR #847.

*Action plan:*
  1. IMMEDIATE: Scale to 4 replicas + set memory limit 768Mi
     Blast radius: api-gateway only | Rollback: scale back to 3
  2. ROOT CAUSE: Review commit diff in v2.4.0 /upload handler
     Suspect: request body not streamed, buffered fully in memory
  3. PREVENT: Add memory usage alert at 80% of limit (614Mi)
     Add load test for /upload with large payloads to CI
```

---

## Layer 3: Incident Learning Loop

### Trigger

When an incident resolves AND the RCA output contains `hypotheses` with at least one entry whose `hypothesis_id` is present and NOT `"unknown:insufficient_evidence"` (i.e., `jq '.hypotheses | map(select(.hypothesis_id != null and .hypothesis_id != "unknown:insufficient_evidence")) | length > 0'`). The explicit null check prevents fail-open when `hypothesis_id` is missing from a hypothesis entry. This schema-based trigger works with both chain output (stages A-B+ produce real hypotheses) and legacy single-shot output. **Legacy schema guarantee**: the existing `lib-rca-prompt.sh` `validate_rca_output()` already normalizes all hypothesis entries to include `hypothesis_id` and `canonical_category` (lines ~108-119), and the heuristic fallback in `lib-rca-llm.sh` (line 41) produces these fields explicitly. So `hypothesis_id` is present in all code paths, not just the chain.

Cases that do **not** generate a card:

1. **Heuristic fallback** (`RCA_MODE=heuristic`): produces `hypothesis_id: "unknown:insufficient_evidence"` → excluded by trigger filter.
2. **Info-severity incidents** (Stage A only): partial result contract fills `hypotheses` with the same `unknown:insufficient_evidence` fallback entry → excluded by the same trigger filter. No special-case logic needed.

Full chain A-D completion produces a richer card. A-B-only results (low severity, or legacy single-shot) contribute a lightweight card with `card_type: "partial"` containing the required partial-card fields defined in Layer 1c (card_id, triage_incident_id, card_type, namespace, cluster, service, date, category, severity, rca_confidence, evidence_fingerprint). This prevents a severity-biased corpus while maintaining a minimum quality bar.

### Incident Card Extraction

One LLM call distills the full RCA into a structured JSON incident card (schema in Layer 1c). **Redaction**: The entire serialized JSON line is passed through `_rca_prompt_scrub()` as a single string before persistence — same approach as incident memory writes (Layer 1c). This catches secrets in any field via regex patterns for bearer tokens, Slack tokens, GitHub PATs, AWS keys, etc. Note: regex-based scrubbing is best-effort; it does not guarantee catching novel secret formats. A test fixture of known secret patterns validates scrub coverage. **Concurrency**: Written via flock + atomic replace (same pattern as active-incidents.tsv). Appended to `incident-memory.jsonl` on PVC.

### Overlay Suggestions

When the bot discovers a failure mode not in the service overlay, it writes a suggestion to `pending-overlay-suggestions.jsonl` (not auto-modify). Same flock + atomic replace write pattern. **Idempotency**: Each suggestion has a deterministic `suggestion_key` (format: `{cluster}:{namespace}:{service}:{proposed_entry.id}`) used for upsert — if a suggestion with the same key already exists in the file, the existing entry is updated (timestamp refreshed, confidence updated to latest) rather than appending a duplicate. Including `cluster` is mandatory to prevent cross-cluster collisions for shared namespace/service names. This prevents repeated heartbeat runs from spamming identical suggestions and evicting distinct entries from the 50-entry cap. The upsert uses a read-modify-write cycle within the flock, which is safe because writes are already serialized. **Redaction**: The entire JSON line is passed through `_rca_prompt_scrub()` before persistence (same as incident memory writes) — required because suggestions are surfaced in the weekly Slack digest and could contain secret fragments from evidence.

```json
{
  "suggestion_key": "dev-morpho:production:api-gateway:oom-upload-buffering",
  "timestamp": "2026-03-03T15:00:00Z",
  "cluster": "dev-morpho",
  "namespace": "production",
  "service": "api-gateway",
  "suggestion_type": "new_failure_mode",
  "proposed_entry": {
    "id": "oom-upload-buffering",
    "pattern": "OOMKilled + /upload endpoint in top-5 by request count",
    "root_cause": "unbounded request body buffering",
    "remediation": "scale replicas + set memory limit, then fix buffering in code",
    "rollback": "revert to previous image tag"
  },
  "source_card_id": "hb:production:resource_exhaustion:20260303T1402:a3f8b2c1",
  "confidence": 85,
  "status": "pending"
}
```

Surfaced via: (1) next triage for same service, (2) weekly Slack digest. **Outbound guard**: Before any suggestion is included in the Slack digest, a second scrub pass runs `_rca_prompt_scrub()` on the serialized entry. If any field still matches known secret patterns (regex + high-entropy token heuristic), the entry is quarantined (marked `status: "quarantined"`) and excluded from the digest until manually reviewed. This provides defense-in-depth: secrets must evade both the write-time scrub and the read-time outbound check. Operator approves by moving into actual overlay YAML.

### Feedback Signals

Only strong, reliable signals adjust confidence. Weak signals are logged but do not modify stored confidence.

| Signal                     | Detection                                   | Effect                             | Reliability |
| -------------------------- | ------------------------------------------- | ---------------------------------- | ----------- |
| Fix PR merged              | Auto-PR created + PR merged                 | +confidence in pattern             | Strong      |
| Incident recurred          | Continuity matcher finds repeat             | Flag: fix didn't hold              | Strong      |
| Operator overrode RCA      | Human posted different root cause in thread | -confidence, store correction      | Strong      |
| Slack reaction (checkmark) | Operator reacted with checkmark emoji       | Logged only (no confidence change) | Weak        |
| Slack reaction (X)         | Operator reacted with X emoji               | Logged only (no confidence change) | Weak        |
| Thread went silent         | No correction within 24h                    | Not used as signal                 | Unreliable  |

Only PR merge, recurrence, and explicit operator override modify stored `rca_confidence`.

### Retention

Severity-weighted eviction (critical/high incidents are preserved longer):

| Severity | Base retention | Max age  | Eviction priority |
| -------- | -------------- | -------- | ----------------- |
| Critical | 180 days       | 365 days | Last              |
| High     | 180 days       | 365 days | Last              |
| Medium   | 90 days        | 180 days | After low         |
| Low      | 60 days        | 90 days  | First             |

Hard cap: 500 entries. When cap reached, evict lowest-severity oldest entries first.

| Data                              | Write pattern                         | Pruning                                   |
| --------------------------------- | ------------------------------------- | ----------------------------------------- |
| incident-memory.jsonl             | flock + atomic replace                | Severity-weighted eviction (see above)    |
| pending-overlay-suggestions.jsonl | flock + atomic replace                | Auto-expire after 30 days, max 50 entries |
| service-graph.json                | flock + atomic replace each heartbeat | Single file, rebuilt each cycle           |

### File lifecycle

New memory files are created in `${INCIDENT_STATE_DIR}` alongside existing state files. The existing cleanup routine in sentinel-triage.sh (spool cleanup, line ~507) is extended to also handle incident-memory.jsonl pruning and pending-overlay-suggestions.jsonl expiry on each heartbeat cycle.

---

## Roadmap

### Phase 1: Knowledge Foundation (0-30 days)

**Goal**: Bot has service context for every RCA. Immediate specificity improvement.

- Week 1-2: Auto-discovery step (tiered service graph builder from K8s labels/selectors/env vars, optional Prometheus)
- Week 3-4: Operational overlay schema + overlays for top 5 services, incident memory restructure from Linear data

Delivers: service context block injected into existing single-shot RCA prompt (no reasoning chain yet). Measurable improvement in specificity without any Step 11 changes.

**Rollout**: Feature-flagged via `SERVICE_CONTEXT_ENABLED=0|1`. Service context block is appended to `build_rca_prompt()` input when enabled. Zero risk to existing pipeline when disabled.

### Phase 2: Reasoning Chain (31-60 days)

**Goal**: Structured causal chain reasoning replaces single-shot synthesis.

- Week 5-6: Stages A + B (triage + hypothesize), severity-adaptive gating, evidence bundle expansion
- Week 7-8: Stages C + D (causal chain + action plan), new Slack output format

**Rollout**: Feature-flagged via `RCA_CHAIN_ENABLED=0|1`. When disabled, legacy single-shot runs. When enabled, chain runs inside `run_step_11()` with same output contract. Can be toggled per-environment (dev first, prod later).

**Phase 2 cross-review gap**: During Phase 2, the chain runs stages A-D only (Stage E ships in Phase 3). Because `RCA_CHAIN_ENABLED=1` disables the external dual-mode loop, Critical/High incidents have no cross-review path during Phase 2. This is an accepted trade-off: Phase 2 focuses on structured reasoning quality (which dramatically improves over single-shot even without cross-review), and operators are the cross-review backstop during this phase. The L2/L3 autonomy gates require `cross-review converged` (Phase 4), so no autonomous actions can be taken without cross-review. For deployments that prefer cross-review over structured reasoning during Phase 2, keep `RCA_CHAIN_ENABLED=0` and use legacy `RCA_MODE=dual` until Phase 3.

Enables original backlog items 6 (evidence correlation) and 8 (change-risk + rollback).

### Phase 3: Cross-Review + Learning (61-90 days)

**Goal**: Self-validating, self-improving system.

- Week 9-10: Stage E (single-pass cross-review with up to 1 revision loop — simpler than legacy dual-mode, validates one chain not two independent RCAs; see Layer 2 Stage E spec). Completes the chain pipeline and restores cross-review capability that was paused during Phase 2.
- Week 11-12: Incident learning loop (card extraction with redaction, overlay suggestions, strong-signal-only feedback, weekly digest)

**Rollout**: Learning loop writes are behind `INCIDENT_LEARNING_ENABLED=0|1`. Stage E is part of the chain (enabled by `RCA_CHAIN_ENABLED=1`); the legacy `RCA_MODE=dual` external loop remains available only when chain mode is disabled.

Enables original backlog items 9 (postmortem auto-packet) and 1 (incident command foundation).

### Phase 4: Operational Features (91-180 days)

Original backlog items, now built on a solid cognitive foundation:

- Month 4: Incident command lifecycle (item 1), unified status card (item 4), CI/CD action cards (item 7)
- Month 5: Autonomy guardrails (item 2), approval orchestrator (item 5), executable runbooks (item 3)
- Month 6: Controlled self-healing for repeat SEV3/4 (item 10), quarterly game day

### Autonomy Levels

| Level | Name              | Gate                                                                                                                                                                                                                                 | Phase   |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| L0    | Observe           | Always on                                                                                                                                                                                                                            | Phase 1 |
| L1    | Recommend         | RCA confidence >= 60% AND evidence_completeness >= 50%                                                                                                                                                                               | Phase 2 |
| L2    | Act-with-approval | Confidence >= 80% AND evidence_completeness >= 70% AND stages_completed includes D (action plan required) AND action_plan_quality != "generic" AND no cross-review disagreement (vacuously true when Stage E was skipped) + human OK | Phase 4 |
| L3    | Auto-remediate    | Confidence >= 95% AND evidence_completeness >= 80% AND cross-review converged AND action_plan_quality != "generic" AND known pattern AND severity Low or Medium only (maps to SEV3/4) AND overlay match AND blast-radius <= low      | Phase 4 |

**Gate variable definitions** (detailed Phase 4 design will refine thresholds):

- `evidence_completeness`: ratio of non-empty step outputs to **applicable** evidence output steps. The current codebase uses a dynamic denominator (`evidence_applicable_steps`) that excludes steps disabled by configuration or environment (e.g., Prometheus steps disabled when no Prometheus is available). This design adopts the same dynamic denominator to stay consistent with the existing metric computation. E.g., if 8 steps are applicable and 6 produce output, completeness = 75%. The denominator is capped at 10 (steps 1-10; step 0 is setup and excluded).
- `known pattern`: incident evidence matches a `known_failure_modes[].pattern` entry in the service overlay with Jaccard similarity >= 0.6 on pattern keywords (comparing evidence signal keys against tokenized pattern text).
- `overlay match`: a service overlay YAML file exists for the affected service with matching `cluster` + `namespace` + `service` AND was loaded during this triage cycle.
- `blast-radius <= low`: action plan's blast radius field is scoped to a single service/namespace (no cross-service or cross-namespace impact).
- `cross-review converged`: Stage E did not produce revision notes (accepted the chain output without changes), OR revision was applied and Stage E accepted the revised output.

### Success Metrics

| Metric                                  | Baseline   | Phase 1  | Phase 2 | Phase 3     |
| --------------------------------------- | ---------- | -------- | ------- | ----------- |
| RCA mentions dependencies               | ~10%       | 60%+     | 80%+    | 90%+        |
| RCA cites specific trigger              | ~20%       | 50%+     | 85%+    | 90%+        |
| Action plan is service-specific         | ~5%        | 40%+     | 80%+    | 90%+        |
| Past incident referenced                | ~15%       | 40%+     | 50%+    | 70%+        |
| Cross-review override rate              | N/A        | N/A      | N/A     | <15%        |
| Repeat incident faster TTD              | N/A        | N/A      | N/A     | 30%+ faster |
| False positive rate (operator override) | unmeasured | baseline | <20%    | <10%        |
| MTTR for repeat incidents               | unmeasured | baseline | -15%    | -30%        |

---

## Rollout Test Gates (Blocking)

The following tests are required before enabling `RCA_CHAIN_ENABLED=1` in production:

1. **Structured category handoff test**: heartbeat cron consumes `step11_payload.primary_category`; when JSON is present, text parser is not used. Assert `meta_alert:legacy_category_parser_hit=0`.
2. **Legacy fallback test**: if structured payload is missing/corrupt, text parser fallback still routes incident and emits exactly one warning metric.
3. **Cross-cluster suggestion idempotency test**: two clusters with same `{namespace,service,proposed_entry.id}` create two distinct `suggestion_key` rows (no overwrite).
4. **Deadline budget test**: with worst-case slow dependencies, run completes under 240s and returns partial result instead of deadline kill.
5. **Sink redaction fail-closed test**: every external sink path (Slack, Linear, webhook, weekly digest) must call `redact_for_sink()`; unresolved entropy token causes quarantine and no outbound send.
6. **Evidence budget test**: when `RCA_EVIDENCE_TOTAL_TIMEOUT_MS` is exceeded, optional evidence steps are skipped, chain still executes, output remains schema-valid.

---

## Appendix: Codex Review Findings Addressed

| #   | Severity | Finding                                        | Resolution                                                                                                                                                            |
| --- | -------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CRITICAL | Step-11 contract mismatch                      | Chain runs inside `run_step_11()`, same JSON output schema, `chain_metadata` additive                                                                                 |
| 2   | CRITICAL | Stage inputs unavailable (only counters)       | Evidence bundle expanded to include raw `STEP_OUTPUT_01`-`10`                                                                                                         |
| 3   | CRITICAL | Latency blows cron deadline                    | Added chain-mode evidence cap (`RCA_EVIDENCE_TOTAL_TIMEOUT_MS=80000`) + chain cap (60s) + partial fallback + corrected 240s cron deadline                             |
| 4   | CRITICAL | Cost underestimates (48 runs/day)              | RCA skip when `evidence_fingerprint` unchanged AND interval not elapsed; re-run on fingerprint change or stale-result refresh after `RCA_MIN_RERUN_INTERVAL_S`        |
| 5   | CRITICAL | Service graph assumptions brittle              | Tiered discovery (T1 always, T2 if Prometheus, T3 if mesh) with graceful degradation                                                                                  |
| 6   | CRITICAL | JSONL no locking/atomicity                     | All JSONL writes use flock + atomic replace (inheriting `lib-state-file.sh` pattern)                                                                                  |
| 7   | CRITICAL | Cron category extraction breaks                | Structured category handoff: read `step11_payload.primary_category`; text parser fallback only with warning metric, then remove fallback                              |
| 8   | HIGH     | Multiple kubectl/Prometheus calls              | Corrected: 3-5 kubectl + 1-3 Prometheus queries (~5-10s)                                                                                                              |
| 9   | HIGH     | Stage gates too rigid                          | Softened: >=1 signal (not 3), >=1 support (not 2), incomplete chains flagged not rejected                                                                             |
| 10  | HIGH     | Cross-review weaker than existing              | Stage E uses single-pass + 1 revision loop (2 calls max); simpler than legacy dual but validates within the chain. Legacy dual remains available when chain disabled. |
| 11  | HIGH     | Model routing no config surface                | Added `RCA_STAGE_MODEL_FAST`, `RCA_STAGE_MODEL_STRONG`, `RCA_STAGE_TIMEOUT_MS`, `RCA_CHAIN_TOTAL_TIMEOUT_MS`, `RCA_EVIDENCE_TOTAL_TIMEOUT_MS`                         |
| 12  | HIGH     | Incident card missing identity fields          | Added namespace, cluster, affected_workloads, evidence_fingerprint, rca_model, rca_prompt_version                                                                     |
| 13  | HIGH     | Memory lookup key collision                    | Changed key to `cluster:namespace:service:category` (fully qualified)                                                                                                 |
| 14  | HIGH     | Feedback loop bad signals                      | Only PR merge, recurrence, operator override modify confidence. Emoji/silence logged only                                                                             |
| 15  | HIGH     | Retention no severity-aware eviction           | Severity-weighted eviction: critical/high last, low first                                                                                                             |
| 16  | HIGH     | Security: no redaction on JSONL                | All free-text fields scrubbed via `_rca_prompt_scrub()` before persistence                                                                                            |
| 17  | HIGH     | Rollout optimistic                             | Feature flags per phase (`SERVICE_CONTEXT_ENABLED`, `RCA_CHAIN_ENABLED`, `INCIDENT_LEARNING_ENABLED`) + circuit breaker                                               |
| 18  | CRITICAL | Overlay suggestion key cross-cluster collision | `suggestion_key` now includes `cluster` (`{cluster}:{namespace}:{service}:{id}`), with matching schema/sample update                                                  |
| 19  | CRITICAL | Sink redaction bypass risk                     | Mandatory fail-closed `redact_for_sink(payload, sink)` wrapper for all outbound sinks                                                                                 |
