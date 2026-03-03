# SRE Bot Hybrid Intelligence — Design Document

**Date**: 2026-03-03
**Status**: Approved
**Builds on**: 2026-03-02-sre-bot-deep-signals-design.md

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

Each layer is independently useful and incrementally deployable.

---

## Layer 1: Service Knowledge

Three sources merge into a unified service context document that feeds every RCA.

### 1a. Auto-Discovery

Runs as a new triage step (before LLM synthesis). Produces a topology snapshot from:

| Source                  | What it extracts                                         |
| ----------------------- | -------------------------------------------------------- |
| K8s labels/annotations  | service name, team, tier, namespace                      |
| K8s service selectors   | which deployments back which services                    |
| NetworkPolicy / Istio   | service-to-service call edges                            |
| Prometheus metrics      | request rate, error rate, latency between services       |
| Deploy manifests        | env vars referencing other services (DB hosts, API URLs) |
| ConfigMaps/Secrets refs | shared config dependencies                               |

Output: `service-graph.json` — adjacency list with edges typed as `calls`, `depends-on`, `shares-config`.

```json
{
  "services": {
    "api-gateway": {
      "namespace": "production",
      "team": "platform",
      "tier": "critical",
      "depends_on": ["auth-service", "user-service", "redis-cache"],
      "depended_by": ["web-frontend", "mobile-bff"]
    }
  }
}
```

Runs once per heartbeat cycle (30m), cached to PVC. Cost: one `kubectl` + one Prometheus query batch.

### 1b. Operational Overlays

Per-service YAML files in the skills bundle (deployed via ConfigMap):

```yaml
# service-overlays/api-gateway.yaml
service: api-gateway
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

Missing overlay = fine. The bot works without it — auto-discovered topology still provides dependency context. Overlays get populated over time by manual additions and Layer 3 suggestions.

### 1c. Incident Memory

Restructures the existing Linear memory lookup into structured incident cards:

```json
{
  "incident_id": "hb:prod:resource_exhaustion:1709482020:a3f8b2c1",
  "service": "api-gateway",
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
  "rca_confidence": 85,
  "tags": ["oom", "deploy-triggered", "memory-leak"],
  "lessons": ["No memory limit was set", "Load tests don't cover /upload"]
}
```

Storage: `incident-memory.jsonl` on PVC, one line per resolved incident. Queried by service name + category. Retention: 90 days, max 500 entries (high-confidence entries kept up to 180 days).

### Merged Service Context Block

At RCA time, the reasoning chain receives:

```
=== SERVICE CONTEXT: api-gateway ===
Team: platform (@alice, escalation: @platform-oncall)
Tier: critical
Dependencies: auth-service, user-service, redis-cache
Depended by: web-frontend, mobile-bff
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

---

## Layer 2: Multi-Stage Reasoning Chain

Replaces the current single-shot LLM RCA (Step 11) with five focused stages.

### Why multi-stage beats single-shot

Single-shot fails because: the LLM tries to do everything at once, irrelevant evidence dilutes signal, no structured hypothesis testing, no adversarial check (confirmation bias in a single pass).

### Stage A: Evidence Triage

- **Input**: Raw evidence (steps 1-10) + service context
- **Job**: Classify each evidence piece as signal (relevant), noise (normal/irrelevant), or unknown
- **Output**: Filtered evidence with relevance scores
- **Gate**: Must retain >= 3 signal pieces or escalate to "insufficient evidence" path

### Stage B: Hypothesis Generation

- **Input**: Filtered evidence + service context + incident memory matches
- **Job**: Generate 3-5 ranked hypotheses, each with description, supporting evidence, contradicting evidence, confidence (0-100%), and similar past incident reference
- **Gate**: Top hypothesis must have >= 2 supporting evidence pieces

### Stage C: Causal Chain Construction

- **Input**: Top 2 hypotheses + full service graph
- **Job**: For each hypothesis, construct trigger_event → propagation (via dependency edges) → observed symptoms (mapped to evidence)
- **Output**: Structured causal chains with timestamps
- **Gate**: Chain must link trigger → >= 1 propagation step → >= 1 observed symptom

### Stage D: Action Plan

- **Input**: Top causal chain + service overlay (known remediations, safe/unsafe ops)
- **Job**: Produce ranked actions: (1) IMMEDIATE — stop the bleeding, (2) ROOT CAUSE — fix underlying issue, (3) PREVENTIVE — stop recurrence. Each with blast radius, rollback path, specifics.
- **Gate**: Each action must reference a known remediation from the overlay OR cite causal chain evidence. No generic advice.

### Stage E: Cross-Review

- **Input**: Complete output from stages A-D
- **Job**: Second model validates — does the chain explain ALL symptoms? Contradicting evidence dismissed without justification? Actions safe per unsafe_operations list? Simpler explanation missed?
- **Output**: Validated RCA or revision notes
- **Gate**: Critical gap → loop back to Stage B (max 1 retry)

### Implementation

Each stage is a separate LLM call with a focused system prompt, not a separate service. Wired into `sentinel-triage.sh` replacing Step 11.

### Cost and latency

|          | Calls | Time    | Cost        |
| -------- | ----- | ------- | ----------- |
| Current  | 1     | ~15-30s | ~$0.03-0.08 |
| Proposed | 5     | ~60-90s | ~$0.15-0.40 |

Mitigation: Stages A+B use faster model (Codex/Haiku), C+D use strong model (Claude/GPT-4), E reuses existing dual-mode.

### Severity-Adaptive Depth

| Severity      | Stages            | Reasoning                     |
| ------------- | ----------------- | ----------------------------- |
| Critical/High | A → B → C → D → E | Full chain + cross-review     |
| Medium        | A → B → C → D     | Full chain, skip cross-review |
| Low           | A → B             | Triage + hypotheses only      |
| Info          | A                 | Signal vs noise filter only   |

### Output Format (Slack)

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
  3. PREVENT: Add memory usage alert at 80% of limit (410Mi)
     Add load test for /upload with large payloads to CI
```

---

## Layer 3: Incident Learning Loop

### Trigger

When an incident resolves AND a full RCA was produced (stages A-D completed).

### Incident Card Extraction

One LLM call distills the full RCA into a structured JSON incident card (schema above in Layer 1c). Appended to `incident-memory.jsonl`.

### Overlay Suggestions

When the bot discovers a failure mode not in the service overlay, it writes a suggestion to `pending-overlay-updates.jsonl` (not auto-modify):

```json
{
  "timestamp": "2026-03-03T15:00:00Z",
  "service": "api-gateway",
  "suggestion_type": "new_failure_mode",
  "proposed_entry": {
    "id": "oom-upload-buffering",
    "pattern": "OOMKilled + /upload endpoint in top-5 by request count",
    "root_cause": "unbounded request body buffering",
    "remediation": "scale replicas + set memory limit, then fix buffering in code",
    "rollback": "revert to previous image tag"
  },
  "source_incident": "hb:prod:resource_exhaustion:1709482020:a3f8b2c1",
  "confidence": 85,
  "status": "pending"
}
```

Surfaced via: (1) next triage for same service, (2) weekly Slack digest. Operator approves by moving into actual overlay YAML.

### Feedback Signals

| Signal                | Detection                         | Effect                        |
| --------------------- | --------------------------------- | ----------------------------- |
| Fix PR merged         | Auto-PR created + PR merged       | +confidence in pattern        |
| Incident recurred     | Continuity matcher finds repeat   | Flag: fix didn't hold         |
| Operator overrode RCA | Human posted different root cause | -confidence, store correction |
| Thread went silent    | No correction within 24h          | Weak +signal                  |
| Slack reaction        | Operator reacted with checkmark/X | Direct feedback               |

Signals adjust `rca_confidence` retroactively so future lookups surface higher-quality matches first.

### Retention

| Data                   | Retention                         | Max entries | Pruning                     |
| ---------------------- | --------------------------------- | ----------- | --------------------------- |
| incident-memory.jsonl  | 90 days (180 for high-confidence) | 500         | Oldest first                |
| pending-overlays.jsonl | 30 days                           | 50          | Auto-expire if not approved |
| service-graph.json     | Rebuilt each cycle                | 1           | Overwritten each heartbeat  |

---

## Roadmap

### Phase 1: Knowledge Foundation (0-30 days)

**Goal**: Bot has service context for every RCA. Immediate specificity improvement.

- Week 1-2: Auto-discovery step (service graph builder from K8s/Prometheus)
- Week 3-4: Operational overlay schema + overlays for top 5 services, incident memory restructure from Linear data

Delivers: service context block injected into existing single-shot RCA. Measurable improvement in specificity without any reasoning chain changes.

### Phase 2: Reasoning Chain (31-60 days)

**Goal**: Structured causal chain reasoning replaces single-shot synthesis.

- Week 5-6: Stages A + B (triage + hypothesize), severity-adaptive gating
- Week 7-8: Stages C + D (causal chain + action plan), new Slack output format

Enables original backlog items 6 (evidence correlation) and 8 (change-risk + rollback).

### Phase 3: Cross-Review + Learning (61-90 days)

**Goal**: Self-validating, self-improving system.

- Week 9-10: Stage E (cross-review with retry loop)
- Week 11-12: Incident learning loop (card extraction, overlay suggestions, feedback signals, weekly digest)

Enables original backlog items 9 (postmortem auto-packet) and 1 (incident command foundation).

### Phase 4: Operational Features (91-180 days)

Original backlog items, now built on a solid cognitive foundation:

- Month 4: Incident command lifecycle (item 1), unified status card (item 4), CI/CD action cards (item 7)
- Month 5: Autonomy guardrails (item 2), approval orchestrator (item 5), executable runbooks (item 3)
- Month 6: Controlled self-healing for repeat SEV3/4 (item 10), quarterly game day

### Autonomy Levels

| Level | Name              | Gate                                                                                  | Phase   |
| ----- | ----------------- | ------------------------------------------------------------------------------------- | ------- |
| L0    | Observe           | Always on                                                                             | Phase 1 |
| L1    | Recommend         | RCA confidence >= 60%                                                                 | Phase 2 |
| L2    | Act-with-approval | Confidence >= 80% + human OK                                                          | Phase 4 |
| L3    | Auto-remediate    | Confidence >= 95% + known pattern + SEV3/4 only + overlay match + blast-radius <= low | Phase 4 |

### Success Metrics

| Metric                          | Baseline | Phase 1 | Phase 2 | Phase 3     |
| ------------------------------- | -------- | ------- | ------- | ----------- |
| RCA mentions dependencies       | ~10%     | 60%+    | 80%+    | 90%+        |
| RCA cites specific trigger      | ~20%     | 50%+    | 85%+    | 90%+        |
| Action plan is service-specific | ~5%      | 40%+    | 80%+    | 90%+        |
| Past incident referenced        | ~15%     | 40%+    | 50%+    | 70%+        |
| Cross-review override rate      | N/A      | N/A     | N/A     | <15%        |
| Repeat incident faster TTD      | N/A      | N/A     | N/A     | 30%+ faster |
