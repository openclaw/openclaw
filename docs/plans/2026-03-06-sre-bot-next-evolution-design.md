# SRE Bot "Next Evolution" — Merged Design Brief

**Date:** 2026-03-06
**Status:** Draft (merged synthesis)
**Builds on:** 2026-03-02-sre-bot-deep-signals-design.md, 2026-03-03-sre-hybrid-intelligence-design.md
**Inputs:** local code review, deployed OpenClaw SRE config/skills, 4-agent analyst team
**Implementation plan:** `docs/plans/2026-03-06-sre-bot-next-evolution-plan.md`

## Executive Summary

The current SRE bot is already strong:

- evidence pipeline + RCA chain
- service graph + incident memory
- specialist agents
- repo clone / CI / Argo / BetterStack / Linear helpers
- multi-session + subagent runtime

The original draft is directionally right, especially on:

- full-chain traceability
- temporal/change awareness
- deeper investigations
- multi-repo fixes

But it overstates one point: **Helm lineage is not the only keystone**.

The real missing foundation is broader:

1. **typed provenance + relationship graph**
2. **structured evidence contracts**
3. **persistent incident dossier**
4. **repo ownership + cross-repo execution contract**

Without those, lineage stays one more script, investigations stay shell-output centric, and multi-repo fixes stay brittle.

**Merged thesis:** evolve the bot from "good evidence collector with strong RCA helpers" into a **stateful incident operating system** that can:

- trace a symptom through config, deployment, runtime, metrics, alerts, repos, and PRs
- remember prior investigation state and reuse it across turns/threads
- explain entity relationships with provenance and confidence
- plan and verify coordinated fixes across `openclaw-sre` and `../morpho-infra-helm`

## What The Draft Gets Right

### 1. Full-Chain Traceability matters

Correct. The bot should trace:

`values.yaml -> rendered manifest -> live resource -> pod/image -> metrics/alerts -> deployed commit -> repo/PR`

This is essential for:

- causal RCA
- drift detection
- rollback advice
- change attribution

### 2. Time/context awareness matters

Correct. Change windows, dependency health, and timelines are high-ROI and relatively cheap.

### 3. Investigations must become adaptive

Correct. Gap detection and targeted recollection are better than a fixed one-pass pipeline.

### 4. Multi-repo fixes are the real-world target

Correct. Many fixes span:

- runtime/code in `openclaw-sre`
- skill/config/seed/deploy changes in `../morpho-infra-helm`

## What The Draft Misses

### 1. No first-class provenance / entity model

Today the runtime already captures rich session/tool/subagent metadata, but mostly as flat records. Missing: canonical IDs and edges for:

- incident
- thread
- message
- tool call
- service
- deployment
- pod
- image repo
- GitHub repo
- chart
- env values file
- Argo app
- PR / CI run

Without this, traceability remains ad hoc and not queryable.

### 2. Evidence is still shell-shaped

The deployed SRE skills are powerful, but too much evidence still arrives as text blobs. Missing: normalized JSON/NDJSON evidence rows with:

- `entity_ids`
- `source`
- `scope`
- `observed_at`
- `freshness`
- `confidence`
- `collection_error`

Without this, specialist agents cannot merge or reason cleanly.

### 3. Incident state is not persistent enough

Current memory/session substrate is good, but incident investigations need a durable dossier, not just transcript recall.

### 4. Cross-repo fixes need ownership contracts, not just orchestration

The system needs machine-readable repo/source-of-truth rules, not only prompt instructions like:

- code/runtime change -> `openclaw-sre`
- seeded runtime config / seeded skills / chart wiring -> `../morpho-infra-helm`

### 5. Retrieval is still mostly model-initiated

Memory and extra-path indexing exist, but recall should become runtime-assisted for incident/repo/deploy asks.

### 6. Investigator and fixer need harder separation

Read-heavy incident autonomy is valuable. Mutation autonomy needs a tighter boundary.

## Design Principles

### P1. Graph first, prose second

Store entities and edges first. Generate summaries from them.

### P2. Evidence first, conclusions second

Every hypothesis/action should point to structured evidence rows.

### P3. Freshness is explicit

Every artifact should say when it was observed and when it becomes stale.

### P4. Source-of-truth is machine-readable

Repo ownership and execution policy should be data, not just runbook text.

### P5. Read autonomy > write autonomy

The bot should investigate aggressively and mutate conservatively.

## The Five Pillars

### Pillar A: Provenance and Relationship Graph

**Goal:** make relationships first-class across runtime, incident, infra, and repo domains.

| ID  | Capability                                                  | Impact   | Effort | Phase  |
| --- | ----------------------------------------------------------- | -------- | ------ | ------ |
| G1  | Canonical entity IDs + edge taxonomy                        | CRITICAL | Medium | Next   |
| G2  | Provenance/confidence on every inferred link                | HIGH     | Medium | Next   |
| G3  | Native relationship index plugin                            | HIGH     | Medium | Next   |
| G4  | Native graph query tools (`lookup`, `neighbors`, `explain`) | HIGH     | Medium | Next+1 |
| G5  | Incident/workload/repo/PR unified graph                     | HIGH     | High   | Next+1 |

**Core entities**

- `incident`
- `thread`
- `message`
- `tool_call`
- `artifact`
- `service`
- `deployment`
- `pod`
- `image_repo`
- `github_repo`
- `chart`
- `env_values`
- `argocd_app`
- `pr`
- `ci_run`

**Example edges**

- `message -> thread`
- `thread -> incident`
- `incident -> service`
- `service -> deployment`
- `deployment -> pod`
- `pod -> image_repo`
- `image_repo -> github_repo`
- `github_repo -> chart`
- `chart -> env_values`
- `env_values -> argocd_app`
- `tool_call -> artifact`
- `artifact -> pr`
- `pr -> ci_run`

### Pillar B: Structured Investigation Substrate

**Goal:** replace shell-shaped handoff with durable investigation objects.

| ID  | Capability                                                                      | Impact   | Effort | Phase  |
| --- | ------------------------------------------------------------------------------- | -------- | ------ | ------ |
| S1  | Structured evidence rows (`evidence.ndjson`)                                    | CRITICAL | Medium | Next   |
| S2  | Structured incident bundle (`incident.json`, `hypotheses.json`, `actions.json`) | CRITICAL | Medium | Next   |
| S3  | Persistent incident dossier tree                                                | HIGH     | Medium | Next   |
| S4  | Specialist agent response schema                                                | HIGH     | Medium | Next   |
| S5  | Transcript-to-memory distillation                                               | MEDIUM   | Medium | Next+1 |

**Per-incident dossier**

```text
incidents/<incident-id>/
  summary.md
  incident.json
  timeline.ndjson
  evidence.ndjson
  hypotheses.json
  actions.json
  entities.json
  links.json
```

### Pillar C: Full-Chain Traceability and Context

**Goal:** close config/runtime/time/dependency traceability.

| ID  | Capability                         | Impact   | Effort | Phase  |
| --- | ---------------------------------- | -------- | ------ | ------ |
| T1  | Config lineage tracker             | CRITICAL | Medium | Next   |
| T2  | Change-window awareness            | HIGH     | Low    | Next   |
| T3  | Dependency health propagation      | HIGH     | Medium | Next   |
| T4  | Operational timeline               | HIGH     | Medium | Next   |
| T5  | Temporal correlation engine        | HIGH     | Medium | Next   |
| T6  | Alert-metric-resource mapper       | HIGH     | High   | Next+1 |
| T7  | ArgoCD commit tracking             | HIGH     | Medium | Next+1 |
| T8  | Grafana dashboard intelligence     | MEDIUM   | Medium | Next+2 |
| T9  | Drift detection (rendered vs live) | MEDIUM   | Medium | Next   |

### Pillar D: Retrieval and Investigation Depth

**Goal:** make recall/runtime context proactive, not only tool-invoked by the model.

| ID  | Capability                                    | Impact   | Effort | Phase  |
| --- | --------------------------------------------- | -------- | ------ | ------ |
| R1  | Runtime retrieval prepass / context broker    | CRITICAL | Medium | Next   |
| R2  | Evidence gap detection manifests              | HIGH     | Medium | Next   |
| R3  | Hypothesis-driven recollection                | HIGH     | High   | Next+1 |
| R4  | Blast radius analysis                         | MEDIUM   | Medium | Next+1 |
| R5  | QMD index for dossiers + repos + runbooks     | HIGH     | Medium | Next+1 |
| R6  | Interactive investigation sessions            | MEDIUM   | High   | Next+2 |
| R7  | Counterfactual reasoning / healthy-state diff | MEDIUM   | High   | Next+2 |

### Pillar E: Multi-Repo Execution and Verification

**Goal:** make coordinated fixes safe and systematic.

| ID  | Capability                                   | Impact   | Effort | Phase  |
| --- | -------------------------------------------- | -------- | ------ | ------ |
| M1  | Typed repo ownership graph                   | CRITICAL | Medium | Next   |
| M2  | Cross-repo change-plan object                | CRITICAL | Medium | Next   |
| M3  | Repo-specialized subagents                   | HIGH     | Medium | Next+1 |
| M4  | Change attribution across repos              | HIGH     | High   | Next+1 |
| M5  | Multi-repo PR orchestrator                   | HIGH     | High   | Next+1 |
| M6  | Validation matrix by repo/app edge           | HIGH     | Medium | Next+1 |
| M7  | Cross-repo PR verification bundle            | MEDIUM   | Medium | Next+2 |
| M8  | Change-intel helper (git + helm + Argo + CI) | HIGH     | Medium | Next+1 |

## Unified Architecture

```text
                       ┌──────────────────────────────────────┐
                       │   RUNTIME / SESSION / TOOL EVENTS    │
                       │ sessions, hooks, subagents, memory   │
                       └──────────────────┬───────────────────┘
                                          │
                       ┌──────────────────▼───────────────────┐
                       │ PROVENANCE + RELATIONSHIP GRAPH      │
                       │ entities, edges, confidence, source  │
                       └──────────────────┬───────────────────┘
                                          │
              ┌───────────────────────────▼──────────────────────────┐
              │ STRUCTURED INVESTIGATION SUBSTRATE                   │
              │ incident bundle, evidence rows, dossier, timeline    │
              └───────────────┬───────────────────────┬──────────────┘
                              │                       │
              ┌───────────────▼──────────────┐  ┌────▼────────────────┐
              │ TRACEABILITY + CONTEXT       │  │ RETRIEVAL + REASON  │
              │ lineage, change window,      │  │ broker, gap detect, │
              │ timeline, deps, drift        │  │ recollect, blast    │
              └───────────────┬──────────────┘  └────┬────────────────┘
                              │                       │
                              └──────────────┬────────┘
                                             │
                              ┌──────────────▼──────────────┐
                              │ ACTION + EXECUTION CONTRACT │
                              │ ownership graph, plan, PRs, │
                              │ validation, verification    │
                              └─────────────────────────────┘
```

## Phase Roadmap

### Phase Next: Foundation Contract Layer (3-4 sprints)

**Goal:** make evidence, provenance, and ownership structured enough that everything else can compose.

| ID  | Capability                           | Why now                                |
| --- | ------------------------------------ | -------------------------------------- |
| G1  | Canonical entity IDs + edge taxonomy | missing base abstraction               |
| S1  | Structured evidence rows             | fixes shell-shaped handoff             |
| S2  | Structured incident bundle           | gives chain + agents common contract   |
| S3  | Persistent incident dossier          | unlocks multi-turn reuse               |
| R1  | Runtime retrieval prepass            | upgrades context awareness fast        |
| R2  | Evidence gap manifests               | foundation for adaptive investigations |
| T1  | Config lineage tracker               | closes config -> runtime chain         |
| T2  | Change-window awareness              | highest ROI contextual signal          |
| T3  | Dependency health propagation        | improves causal context                |
| T4  | Operational timeline                 | forensic backbone                      |
| T9  | Drift detection                      | practical output from lineage          |
| M1  | Typed repo ownership graph           | stops wrong-repo planning              |
| M2  | Cross-repo change-plan object        | common contract before mutation        |
| X1  | Investigator/fixer role split        | safer autonomy boundary                |

**Deliverables**

- `incident.schema.json`
- `evidence-row.schema.json`
- `repo-ownership.json`
- `change-plan.schema.json`
- `incident-dossier/` writer + loader
- `context-broker` hook/plugin
- `helm-lineage-tracker.sh`
- `changes-in-window.sh`
- `config-drift-detector.sh`

### Phase Next+1: Composed Intelligence (3-4 sprints)

**Goal:** make specialists and cross-repo execution operate on the new contracts.

| ID  | Capability                            | Dependencies       |
| --- | ------------------------------------- | ------------------ |
| G3  | Native relationship index plugin      | G1, S1             |
| G4  | Native graph query tools              | G3                 |
| G5  | Unified incident/workload/repo graph  | G1, G3, M1         |
| R3  | Hypothesis-driven recollection        | R2, S1             |
| R4  | Blast radius analysis                 | G3                 |
| R5  | QMD index for dossiers/repos/runbooks | S3                 |
| T5  | Temporal correlation engine           | T2, T4             |
| T6  | Alert-metric-resource mapper          | G3, metrics access |
| T7  | ArgoCD commit tracking                | lineage + Argo     |
| M3  | Repo-specialized subagents            | M1, M2             |
| M4  | Change attribution across repos       | T1, M1, G3         |
| M5  | Multi-repo PR orchestrator            | M2, M3             |
| M6  | Validation matrix by repo/app edge    | M1, M2             |
| M8  | Change-intel helper                   | T1, T7, M1         |
| S4  | Specialist response schema            | S1, S2             |
| S5  | Transcript-to-memory distillation     | S3, R5             |

### Phase Next+2: Higher Autonomy (future)

**Goal:** richer interactive and automated workflows on top of a stable substrate.

| ID  | Capability                         |
| --- | ---------------------------------- |
| T8  | Grafana dashboard intelligence     |
| R6  | Interactive investigation sessions |
| R7  | Counterfactual reasoning           |
| M7  | Cross-repo PR verification bundle  |
| C1  | Business context pack              |
| C2  | Developer intent ingestion         |
| C3  | Team knowledge graph               |
| A1  | Safety-gated runbook execution     |

## Detailed Design Notes

### 1. The keystone is not only lineage

The original draft named the config lineage tracker as the keystone.

Merged view:

- **lineage** is the keystone for traceability
- **provenance graph** is the keystone for relationship reasoning
- **structured evidence** is the keystone for investigation quality
- **ownership contract** is the keystone for multi-repo execution

All four are required.

### 2. Repo ownership graph

Machine-readable map should include:

- repo id
- local path
- owned path globs
- source-of-truth rank
- dependent repos
- chart/env/app bindings
- CI probe commands
- validation commands
- rollback hints

Example:

```json
{
  "repos": [
    {
      "id": "openclaw-sre",
      "path": "/workspace/openclaw-sre",
      "owns": ["src/**", "docs/plans/**", ".github/docker/**"],
      "source_of_truth_for": ["runtime", "agent-hooks", "session-runtime"],
      "depends_on": ["morpho-infra-helm"]
    },
    {
      "id": "morpho-infra-helm",
      "path": "/workspace/morpho-infra-helm",
      "owns": ["charts/openclaw-sre/**", "environments/*/openclaw-sre/**"],
      "source_of_truth_for": ["seed-config", "seed-skills", "deployment-values"],
      "depends_on": []
    }
  ]
}
```

### 3. Specialist subagents must share one schema

Each specialist returns:

```json
{
  "findings": [],
  "top_hypotheses": [],
  "missing_data": [],
  "next_checks": [],
  "evidence_refs": []
}
```

No freeform-only handoffs.

### 4. Freshness must be universal

Every collected artifact should expose:

- `observed_at`
- `ttl_seconds`
- `stale_after`
- `collection_error`

This lets the bot say:

- repo map fresh
- Prometheus stale
- Argo unavailable

instead of blending old and new evidence.

### 5. Mutation boundary

Two postures:

- **investigator**
  - broad read access
  - structured evidence collection
  - no cluster mutations
  - no broad write/push rights

- **fixer**
  - consumes approved change plan
  - repo-scoped writes only
  - PR creation / branch push
  - optional tightly-gated cluster actions later

## Success Metrics

### Investigation quality

- percent of incidents with structured dossier
- percent of RCA claims linked to evidence rows
- median evidence completeness score
- percent of incidents with explicit freshness summary

### Context awareness

- percent of incident turns using retrieval prepass
- percent of incident turns enriched with recent changes
- percent of dependent-service incidents correctly marked as cascades/supporting

### Relationship quality

- percent of incidents with graph links:
  - incident -> service
  - service -> deployment
  - deployment -> image
  - image -> repo
  - repo -> chart/env
- precision of inferred repo/owner links

### Multi-repo execution

- percent of fixes with correct target repo on first plan
- percent of multi-repo fixes using structured change plan
- percent of linked PRs with full validation bundle

## Safety and Cost

### Safety

- default remains read-only investigation
- no auto-merge
- no uncontrolled cluster mutation
- repo allowlists + owned-path allowlists
- source-of-truth mismatch -> hard fail

### Cost

Phase Next cost growth is controlled by:

- caching lineage/graph outputs
- retrieval prepass only for matching intents
- structured evidence reuse across specialists
- dossier reuse across follow-ups

This should reduce repeated recollection and offset some new collection cost.

## Final Recommendation

Do **not** treat this as "add five more SRE scripts".

Treat it as a substrate upgrade:

1. add provenance graph
2. add structured evidence contracts
3. add persistent incident dossier
4. add repo ownership + change-plan contracts
5. then layer lineage, adaptive investigation, and multi-repo orchestration on top

That sequence matches what the codebase and deployed runtime already support, and fixes the actual bottleneck between today's strong helpers and tomorrow's higher autonomy.
