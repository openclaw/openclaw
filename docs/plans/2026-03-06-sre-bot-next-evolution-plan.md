# SRE Bot Next Evolution — Implementation Plan

**Goal:** implement the merged next-evolution design in a way that is incremental, testable, and safe across both codebases:

- runtime/core repo: `openclaw-sre`
- deployed chart/seed repo: `../morpho-infra-helm`

**Design doc:** `docs/plans/2026-03-06-sre-bot-next-evolution-design.md`

**Primary outcome:** move from "strong RCA helpers" to a stateful incident system with:

- typed provenance / relationship graph
- structured evidence contracts
- persistent incident dossiers
- runtime-assisted retrieval
- traceability from config -> runtime -> alert -> repo -> PR
- safe multi-repo planning / fix orchestration

**Implementation strategy:** ship the substrate first, then wire smarter investigations and multi-repo execution on top. Do not start with more ad hoc shell scripts.

## Scope

This plan covers:

- OpenClaw runtime/session/plugin changes in `openclaw-sre`
- seeded SRE skills, config, chart, and rollout wiring in `../morpho-infra-helm`
- dev-first rollout with feature flags and shadow-mode validation

This plan does **not** include:

- broad cluster mutation automation
- auto-merge
- autonomous cross-repo rollout without explicit validation

## Working Assumptions

- Existing SRE skill bundle remains the primary live collector for infra signals.
- Existing OpenClaw hooks/session/memory surfaces remain the primary integration seams.
- `relationship-knowledge-build.sh`, `lib-service-graph.sh`, `lib-incident-memory.sh`, `autofix-pr.sh`, `argocd-sync-status.sh`, and `github-ci-status.sh` stay in service, but their outputs get normalized and made queryable.
- Feature rollout starts in `environments/dev/openclaw-sre/values.yaml`, then `environments/prd/openclaw-sre/values.yaml`.

## Phase Dependency Graph

```text
Phase 0  Contracts + rollout scaffolding
  └── Phase 1  Provenance graph + structured evidence + dossier
        ├── Phase 2  Retrieval broker + traceability + context
        ├── Phase 3  Adaptive investigations + indexing
        └── Phase 4  Multi-repo planning + execution contracts
              └── Phase 5  Verification, rollout, hardening
```

## Phase 0: Contracts And Rollout Scaffolding

**Goal:** define the contracts and deploy toggles before touching behavior.

### Task 0.1: Add shared contract module in `openclaw-sre`

**Files**

- Create: `src/sre/contracts/entity.ts`
- Create: `src/sre/contracts/evidence.ts`
- Create: `src/sre/contracts/incident-dossier.ts`
- Create: `src/sre/contracts/change-plan.ts`
- Create: `src/sre/contracts/index.ts`
- Create tests:
  - `src/sre/contracts/entity.test.ts`
  - `src/sre/contracts/evidence.test.ts`
  - `src/sre/contracts/incident-dossier.test.ts`
  - `src/sre/contracts/change-plan.test.ts`

**Contract types**

- `EntityId`
- `RelationshipEdge`
- `ProvenanceRef`
- `EvidenceRow`
- `IncidentBundle`
- `IncidentDossierIndex`
- `ChangePlan`
- `RepoOwnershipMap`
- `SpecialistFindingsEnvelope`

**Requirements**

- ASCII-only JSON-compatible shapes
- no `any`
- explicit version field on every top-level artifact
- deterministic IDs where feasible
- stable enum strings for evidence source / edge type / artifact type

**Verification**

- `pnpm build`
- `pnpm test -- src/sre/contracts`

### Task 0.2: Add config surfaces and feature flags

**Files**

- Modify: `src/config/types.ts`
- Modify: `src/config/config.ts`
- Modify: `src/plugins/types.ts`
- Modify docs/config references if needed

**New config blocks**

- `sre.provenance.enabled`
- `sre.structuredEvidence.enabled`
- `sre.incidentDossier.enabled`
- `sre.contextBroker.enabled`
- `sre.repoOwnership.enabled`
- `sre.multiRepoPlanning.enabled`
- `sre.changeIntel.enabled`
- `sre.relationshipIndex.enabled`

**Helm/config wiring**

- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/values.yaml`
- Modify:
  - `../morpho-infra-helm/environments/dev/openclaw-sre/values.yaml`
  - `../morpho-infra-helm/environments/prd/openclaw-sre/values.yaml`

**Flag defaults**

- all new features off by default
- dev env enables shadow / collection-only modes first
- prod stays off until Phase 5 validation

### Task 0.3: Define on-disk state layout

**Files**

- Create: `src/sre/state/paths.ts`
- Create: `src/sre/state/paths.test.ts`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/values.yaml`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/templates/deployment.yaml`

**New state roots**

- `/home/node/.openclaw/state/sre-graph`
- `/home/node/.openclaw/state/sre-dossiers`
- `/home/node/.openclaw/state/sre-index`
- `/home/node/.openclaw/state/sre-plans`

**Requirements**

- no collision with existing `incidentState.dir`
- flock-compatible
- safe on single-replica PVC
- path helpers centralized

### Task 0.3b: Define seeded-skill test location convention

**Why**

`../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/*` is shipped into the live runtime. Test scripts must not live there.

**Rule**

- all new shell tests live under:
  - `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/`
- no `test-*.sh` files under `files/seed-skills/`

**Verification**

- `seed-static.yaml` and deployment copy paths do not pick up test files
- test runner paths use `charts/openclaw-sre/tests/seed-skills/`

### Task 0.4: Add repo bootstrap manifest

**Why**

Current runtime image bakes `morpho-infra` and `morpho-infra-helm`, not `openclaw-sre`. Cross-repo planning needs deterministic repo roots, not ad hoc clone-on-demand only.

**Files**

- Create: `src/sre/repo-bootstrap/manifest.ts`
- Create: `src/sre/repo-bootstrap/manifest.test.ts`
- Modify: `.github/docker/Dockerfile.ecr-runtime`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/templates/deployment.yaml`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`

**Decision**

Use a repo bootstrap manifest with:

- repo id
- expected local path
- clone strategy
- refresh policy
- source-of-truth domains

**Preferred outcome**

- add `openclaw-sre` to deterministic runtime checkout set
- keep `repo-clone.sh` for non-core repos

**Verification**

- runtime image build passes
- bootstrapped paths exist in container
- existing skill scripts keep working

### Task 0.5: Implement bootstrap repo ownership graph

**Why**

The context broker and later multi-repo planning both need machine-readable source-of-truth data early. This cannot wait until the execution phase.

**Files**

- Create: `src/sre/repo-ownership/types.ts`
- Create: `src/sre/repo-ownership/load.ts`
- Create: `src/sre/repo-ownership/validate.ts`
- Create tests:
  - `src/sre/repo-ownership/load.test.ts`
  - `src/sre/repo-ownership/validate.test.ts`
- Create seeded ownership file:
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/repo-ownership.json`
- Modify:
  - `../morpho-infra-helm/charts/openclaw-sre/templates/configmap.yaml`
  - `../morpho-infra-helm/charts/openclaw-sre/templates/deployment.yaml`
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`

**Initial scope**

- `openclaw-sre`
- `morpho-infra-helm`

**Fields**

- repo id
- local path
- owned globs
- source-of-truth domains
- dependent repos
- CI checks
- validation commands
- rollback hints

**Verification**

- ownership file is seeded into runtime state
- loader resolves both repos successfully
- invalid overlaps / invalid globs fail validation

## Phase 1: Provenance Graph, Structured Evidence, Incident Dossier

**Goal:** standardize how facts and relationships are captured.

### Task 1.1: Extend session metadata with canonical relationship fields

**Files**

- Modify: `src/config/sessions/types.ts`
- Modify: `src/config/sessions/metadata.ts`
- Modify: `src/channels/session.ts`
- Create tests:
  - `src/config/sessions/metadata.relationships.test.ts`
  - `src/channels/session.relationships.test.ts`

**Add fields**

- `entityRefs?: string[]`
- `incidentId?: string`
- `threadEntityId?: string`
- `repoRefs?: string[]`
- `artifactRefs?: string[]`

**Rules**

- keep legacy metadata compatible
- no leakage of origin across unrelated target sessions

### Task 1.2: Add provenance fields to plugin hook events

**Files**

- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/hooks.ts`
- Modify tests:
  - `src/plugins/wired-hooks-subagent.test.ts`
  - `src/auto-reply/reply/session-hooks-context.test.ts`
  - add `src/plugins/wired-hooks-provenance.test.ts`

**Changes**

- enrich `message_received`, `after_tool_call`, `tool_result_persist`, `before_message_write`, `subagent_spawned`, `subagent_ended`
- include optional:
  - `entityId`
  - `parentEntityId`
  - `sourceRefs`
  - `derivedFrom`
  - `confidence`

### Task 1.3: Implement relationship index writer plugin

**Files**

- Create: `src/plugins/bundled/relationship-index/index.ts`
- Create: `src/plugins/bundled/relationship-index/store.ts`
- Create: `src/plugins/bundled/relationship-index/ids.ts`
- Create: `src/plugins/bundled/relationship-index/edges.ts`
- Modify plugin registration / enablement surfaces as needed:
  - `src/plugins/loader.ts`
  - bundled plugin discovery/registration paths if required
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`
- Create tests:
  - `src/plugins/bundled/relationship-index/index.test.ts`
  - `src/plugins/bundled/relationship-index/store.test.ts`

**Behavior**

- consume hook events
- emit:
  - `nodes.ndjson`
  - `edges.ndjson`
  - `latest-by-entity.json`
- append-only with periodic compaction
- load only when `sre.relationshipIndex.enabled = true`

**Initial edge set**

- message -> thread
- thread -> incident
- tool_call -> artifact
- subagent -> requester session
- session -> repo/workdir

### Task 1.4: Add structured evidence row library to seeded SRE skills

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/lib-evidence-row.sh`
- Create test: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-evidence-row.sh`
- Modify:
  - `../morpho-infra-helm/charts/openclaw-sre/templates/configmap.yaml`
  - `../morpho-infra-helm/charts/openclaw-sre/templates/deployment.yaml`

**Functions**

- `evidence_row_build`
- `evidence_row_with_freshness`
- `evidence_row_with_entities`
- `evidence_rows_write_ndjson`

**Required fields**

- `version`
- `source`
- `kind`
- `scope`
- `observed_at`
- `ttl_seconds`
- `stale_after`
- `confidence`
- `entity_ids`
- `payload`
- `collection_error`

### Task 1.5: Normalize sentinel outputs into incident bundle + dossier

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/lib-incident-dossier.sh`
- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/sentinel-triage.sh`
- Create tests:
  - `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-incident-dossier.sh`
  - targeted regression tests for sentinel bundle write path

**Outputs**

- `incident.json`
- `timeline.ndjson`
- `evidence.ndjson`
- `hypotheses.json`
- `actions.json`
- `entities.json`
- `links.json`

**Requirements**

- bundle write is additive at first
- keep existing RCA text output unchanged in shadow mode
- reuse current incident identity when possible

### Task 1.6: Standardize specialist agent response schema

**Files**

- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`
- Modify relevant prompts / skills:
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/SKILL.md`
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/HEARTBEAT.md`

**Schema**

- `findings`
- `top_hypotheses`
- `missing_data`
- `next_checks`
- `evidence_refs`

**Verification**

- shadow runs show structured specialist envelopes
- no regression to current thread summary format

## Phase 2: Retrieval Broker, Traceability, Context

**Goal:** make context proactive and traceability complete enough to support better RCA.

### Task 2.1: Add runtime context broker

**Files**

- Create: `src/sre/context-broker/index.ts`
- Create: `src/sre/context-broker/classifier.ts`
- Create: `src/sre/context-broker/inject.ts`
- Create tests:
  - `src/sre/context-broker/index.test.ts`
  - `src/sre/context-broker/classifier.test.ts`
- Modify integration seams:
  - `src/plugins/hooks.ts`
  - `src/agents/pi-embedded-runner/run/attempt.ts`

**Behavior**

- classify prompt intent:
  - prior-work
  - incident follow-up
  - repo/deploy ownership
  - multi-repo fix planning
- run targeted retrieval
- inject top evidence into `prependContext`

**Data sources**

- memory/QMD
- incident dossier
- relationship index
- repo ownership map

### Task 2.2: Add change-window collector

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/changes-in-window.sh`
- Create tests: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-changes-in-window.sh`
- Modify: `sentinel-triage.sh`

**Signals**

- Argo syncs
- pod restarts
- HPA/scaling changes
- image tag changes
- secret/configmap changes when visible

**Output**

- `timeline.ndjson` evidence rows
- one summary block for RCA prompt

### Task 2.3: Add config lineage tracker

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/helm-lineage-tracker.sh`
- Create tests: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-helm-lineage-tracker.sh`
- Modify:
  - `relationship-knowledge-build.sh`
  - `sentinel-triage.sh`

**Responsibilities**

- render chart with current env values
- map live deployment fields back to chart/value paths
- attach Git history for implicated value/template files

**Initial target fields**

- image
- resources
- env / envFrom
- replicas / HPA bounds
- probes
- annotations tied to behavior

### Task 2.4: Extend service context with dependency health propagation

**Files**

- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/lib-service-context.sh`
- Modify: `lib-service-graph.sh`
- Add tests:
  - `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-service-context-dependency-health.sh`

**Behavior**

- for implicated service, include degraded dependencies and dependents
- mark likely cascades vs primary failure candidates

### Task 2.5: Add config drift detector

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/config-drift-detector.sh`
- Create tests: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-config-drift-detector.sh`
- Modify:
  - `argocd-sync-status.sh`
  - `sentinel-triage.sh`

**Behavior**

- compare rendered spec vs live state
- emit evidence rows with scope + severity
- do not auto-remediate

### Task 2.6: Add operational timeline formatter

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/lib-timeline.sh`
- Modify: `sentinel-triage.sh`
- Add tests: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-timeline.sh`

**Behavior**

- merge changes, alerts, restarts, degradation points into one sortable timeline
- support +/- window queries for temporal correlation

## Phase 3: Adaptive Investigations And Indexing

**Goal:** make the bot know what is missing and recollect intentionally.

### Task 3.1: Add evidence gap manifests

**Files**

- Create dir: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/evidence-manifests/`
- Create category YAML files:
  - `resource_exhaustion.yaml`
  - `bad_deploy.yaml`
  - `config_drift.yaml`
  - `dependency_failure.yaml`
  - `network_connectivity.yaml`
  - `cert_or_secret_expiry.yaml`
  - `scaling_issue.yaml`
  - `data_issue.yaml`
- Create: `lib-evidence-gaps.sh`
- Add tests: `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-evidence-gaps.sh`

**Output**

- completeness percent
- missing critical
- missing optional
- confidence penalty

### Task 3.2: Add hypothesis-driven recollection loop

**Files**

- Modify:
  - `lib-rca-chain.sh`
  - `lib-rca-llm.sh`
  - `sentinel-triage.sh`
- Create helpers:
  - `lib-hypothesis-recollect.sh`
- Add tests:
  - `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-hypothesis-recollect.sh`

**Behavior**

- if confidence below threshold and missing critical evidence exists:
  - run targeted collectors
  - append evidence rows
  - rerun relevant RCA stage(s)

**Guardrails**

- bounded retries
- total budget cap
- explicit record of why recollection happened

### Task 3.3: Add QMD indexing for dossiers, repos, runbooks

**Files**

- Modify: `src/memory/search-manager.ts`
- Modify: `src/agents/tools/memory-tool.ts`
- Modify docs/config if needed
- Modify seed config:
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`

**Index sources**

- incident dossier tree
- seeded runbooks / safety docs
- repo docs / key code paths
- selected session summaries

**Requirements**

- citations preserved
- freshness surfaced where available
- fallback to current manager if QMD unavailable

### Task 3.4: Add transcript-to-dossier and transcript-to-memory distillation

**Files**

- Create: `src/sre/distillation/index.ts`
- Create tests: `src/sre/distillation/index.test.ts`
- Modify:
  - `src/plugins/hooks.ts`
  - `src/agents/pi-extensions/compaction-safeguard.ts`

**Behavior**

- on compaction/session end/subagent end:
  - extract durable findings
  - update incident dossier
  - write concise memory note when appropriate

### Task 3.5: Add native relationship query tools

**Files**

- Create:
  - `src/agents/tools/relationship-lookup.ts`
  - `src/agents/tools/relationship-neighbors.ts`
  - `src/agents/tools/relationship-explain.ts`
- Create tests for each
- Wire into tool registry

**Behavior**

- query local relationship index first
- explain provenance / confidence of edges
- return concise, typed results

## Phase 4: Multi-Repo Planning And Execution Contracts

**Goal:** make cross-repo fixes safe, explainable, and verifiable.

### Task 4.1: Implement runtime owned-path enforcement for fixer agents

**Files**

- Modify: `src/plugins/path-safety.ts`
- Modify: `src/agents/tool-policy.ts`
- Modify likely tool/runtime enforcement seams:
  - `src/agents/pi-tools.ts`
  - `src/agents/pi-embedded-subscribe.tools.ts`
  - `src/agents/tool-policy-pipeline.ts`
- Create tests:
  - `src/agents/tool-policy.owned-paths.test.ts`
  - `src/agents/pi-tools.owned-paths.test.ts`

**Behavior**

- for fixer-style agents, writes/edits/patches must stay inside repo-owned globs
- source-of-truth mismatch fails closed
- verifier and investigator agents stay read-only
- exec-based writes outside owned roots are rejected when routed through fixer profile

**Inputs**

- repo ownership graph from Phase 0
- agent role/profile
- target path / workdir

### Task 4.2: Implement change-plan object and validator

**Files**

- Create: `src/sre/change-plan/validate.ts`
- Create: `src/sre/change-plan/render.ts`
- Create tests
- Create seeded helper:
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/change-plan-check.sh`

**Plan fields**

- incident / request id
- root cause summary
- `repos[]`
- per repo:
  - rationale
  - files
  - expected validations
  - rollback
  - PR metadata
- inter-repo dependencies

### Task 4.3: Add repo-specialized subagents

**Files**

- Modify: `../morpho-infra-helm/charts/openclaw-sre/files/seed-config/openclaw.json`
- Add new agents:
  - `sre-repo-runtime`
  - `sre-repo-helm`
  - `sre-verifier`

**Policy**

- `sre-repo-runtime`: only `openclaw-sre` workspace/path ownership
- `sre-repo-helm`: only `morpho-infra-helm` owned files
- `sre-verifier`: read-only validation tools + CI/Argo checks

**Requirements**

- deny non-owned writes
- deny source-of-truth mismatch
- require change plan for fixer runs

### Task 4.4: Extend `autofix-pr.sh` into multi-repo orchestration wrapper

**Files**

- Create:
  - `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/multi-repo-pr.sh`
- Possibly modify:
  - `autofix-pr.sh`
  - `self-improve-pr.sh`
- Add tests:
  - `../morpho-infra-helm/charts/openclaw-sre/tests/seed-skills/test-multi-repo-pr.sh`

**Behavior**

- read validated change plan
- create linked branches/PRs in dependency order
- cross-link sibling PRs
- attach validation bundle summary
- refuse repos outside allowlist

### Task 4.5: Add change-intel helper

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/change-intel.sh`
- Add tests

**Inputs**

- image repo map
- git history
- CI status
- Helm env/chart diff
- Argo sync status

**Outputs**

- ranked likely changes near incident window
- evidence rows linking symptom -> change candidate

### Task 4.6: Add validation matrix runner

**Files**

- Create: `../morpho-infra-helm/charts/openclaw-sre/files/seed-skills/validate-change-plan.sh`
- Add tests

**Checks**

- runtime repo gate:
  - `pnpm build`
  - targeted tests
- helm repo gate:
  - `helm template`
  - chart/config checks
  - impacted app detection
- rollout checks:
  - CI status
  - Argo drift/sync

## Phase 5: Verification, Rollout, Hardening

**Goal:** ship safely and prove the substrate works before broad enablement.

### Task 5.1: Dev shadow mode

**Enable in dev only**

- provenance graph: on
- structured evidence: on
- incident dossier: on
- context broker: shadow/log-only first
- change plan: generation only
- multi-repo PR orchestration: off

**Verification**

- no regression in current Slack thread output
- dossier files written
- evidence rows valid
- graph nodes/edges present
- no token/cost blow-up beyond agreed envelope

### Task 5.2: Add observability for new substrate

**Files**

- OpenClaw runtime metrics/logs in `openclaw-sre`
- possibly seeded Grafana/dashboard helpers in helm repo

**Metrics**

- dossier writes
- graph node/edge counts
- retrieval broker hit rate
- gap detection rate
- recollection rate
- change-plan validation pass/fail
- wrong-repo plan rejection count

### Task 5.3: Canary in dev incidents

**Procedure**

- run on live dev monitoring threads
- compare:
  - RCA quality
  - plan correctness
  - context reuse
  - repeated-query savings

### Task 5.4: Enable prod read-side features

**Prod-first enabled**

- provenance graph
- structured evidence
- incident dossier
- context broker
- traceability collectors
- gap detection

**Prod-later enabled**

- repo-specialized fixers
- multi-repo PR orchestration

### Task 5.5: Enable fix planning, then PR orchestration

**Gate sequence**

1. generate change plans only
2. validate plans only
3. allow human-reviewed single-repo PRs
4. allow human-reviewed multi-repo PR bundles

### Task 5.6: Hardening pass

**Targets**

- stale artifact cleanup
- dossier compaction
- graph compaction
- QMD performance / fallback behavior
- path ownership edge cases
- subagent timeout / retry safety

## Detailed File Impact Map

### `openclaw-sre`

Likely create / modify:

- `src/config/sessions/types.ts`
- `src/config/sessions/metadata.ts`
- `src/channels/session.ts`
- `src/plugins/types.ts`
- `src/plugins/hooks.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/tools/memory-tool.ts`
- `src/memory/search-manager.ts`
- `src/agents/pi-extensions/compaction-safeguard.ts`
- new `src/sre/**`
- new bundled plugin / tool files

### `../morpho-infra-helm`

Likely create / modify:

- `charts/openclaw-sre/files/seed-config/openclaw.json`
- `charts/openclaw-sre/templates/configmap.yaml`
- `charts/openclaw-sre/templates/deployment.yaml`
- `charts/openclaw-sre/values.yaml`
- `environments/dev/openclaw-sre/values.yaml`
- `environments/prd/openclaw-sre/values.yaml`
- `charts/openclaw-sre/files/seed-skills/sentinel-triage.sh`
- new helper libs / tests under `charts/openclaw-sre/files/seed-skills/`

## Verification Matrix

### Runtime repo

- `pnpm build`
- `pnpm tsgo`
- targeted `pnpm test` for new modules

### Helm / seeded skills repo

- `helm template` for `charts/openclaw-sre`
- shell tests for new scripts
- smoke run of seeded init copy path

### End-to-end

- dev bot writes dossier + graph artifacts
- dev bot answers follow-up question using dossier/retrieval broker
- dev bot produces valid change plan for:
  - runtime-only change
  - helm-only change
  - cross-repo change
- verifier agent rejects wrong-repo or unowned-path plan

## Feature Flag Matrix

| Flag                             | Default | Dev phase         | Prod phase              | Notes                              |
| -------------------------------- | ------- | ----------------- | ----------------------- | ---------------------------------- |
| `sre.provenance.enabled`         | off     | Phase 1 shadow-on | Phase 5 read-side on    | graph/event capture only           |
| `sre.structuredEvidence.enabled` | off     | Phase 1 on        | Phase 5 on              | dual-write before full use         |
| `sre.incidentDossier.enabled`    | off     | Phase 1 on        | Phase 5 on              | write/read from new dossier tree   |
| `sre.contextBroker.enabled`      | off     | Phase 2 shadow-on | Phase 5 on              | inject-only after confidence       |
| `sre.relationshipIndex.enabled`  | off     | Phase 1 shadow-on | Phase 5 on              | native query layer depends on this |
| `sre.repoOwnership.enabled`      | off     | Phase 0 shadow-on | Phase 5 on              | retrieval + planning gate          |
| `sre.multiRepoPlanning.enabled`  | off     | Phase 4 plan-only | Phase 5 plan-only first | no writes at first                 |
| `sre.changeIntel.enabled`        | off     | Phase 4 on        | Phase 5 on              | read-side only                     |
| `sre.multiRepoPr.enabled`        | off     | Phase 5 off       | Phase 5 guarded canary  | final enable last                  |

## Acceptance Criteria

### Phase 1 complete when

- every incident can emit valid `incident.json` + `evidence.ndjson`
- graph store records core runtime/session/tool edges

### Phase 2 complete when

- bot can explain a live symptom via:
  - recent changes
  - dependency health
  - lineage
  - drift summary

### Phase 3 complete when

- bot detects missing critical evidence and triggers bounded recollection
- incident follow-up queries reuse stored dossier state

### Phase 4 complete when

- bot generates valid change plans for `openclaw-sre`, `morpho-infra-helm`, or both
- repo-specialized fixers respect owned-path policy
- multi-repo PR bundles are linked and validated

### Phase 5 complete when

- dev and prod read-side features are stable
- multi-repo planning is correct enough to trust with human-reviewed PR generation

## Open Questions

1. Should the provenance/relationship index live as a bundled plugin under `src/plugins/bundled/`, or as a core SRE module with its own registration path?
2. Should `openclaw-sre` be baked into the runtime image permanently, or cloned/refreshed from a bootstrap manifest at pod start?
3. Should dossier/query indexing use QMD as the primary store from day one, or use file-backed artifacts first and add QMD as a read accelerator in Phase 3?
4. Should repo ownership data live in seeded JSON in `morpho-infra-helm`, or in `openclaw-sre` with env-specific overlays seeded from Helm?
5. For multi-repo PR orchestration, should each repo keep its existing PR helper invocation, or should there be one new orchestrator that shells out to repo-local helpers?

## Risks And Mitigations

| Risk                                                | Impact | Mitigation                                                                       |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Graph/provenance schema churn across phases         | medium | version every artifact; add compat readers before migrating writers              |
| Token/cost increase from retrieval broker           | medium | shadow mode first; intent gating; injected-char budgets; cache dossier summaries |
| Sentinel pipeline regression from bundle dual-write | high   | shadow-write first; keep legacy text outputs unchanged until Phase 5             |
| Wrong-repo writes during early multi-repo work      | high   | enforce ownership graph before any fixer agent; hard fail on ambiguity           |
| QMD operational instability                         | medium | keep current memory backend fallback; treat QMD as additive first                |
| PVC growth from dossiers/graphs                     | medium | add retention/compaction in Phase 5; separate dirs per artifact type             |
| Specialist agent divergence                         | medium | require shared response schema before using outputs in planning                  |

## Recommended Build Order

1. contracts
2. graph/event plumbing
3. evidence rows
4. incident dossier
5. context broker
6. change window + timeline
7. lineage + drift
8. evidence gaps
9. QMD indexing
10. repo ownership graph
11. context broker with ownership-aware retrieval
12. change plan
13. owned-path enforcement
14. specialized subagents
15. PR orchestration

## Non-Negotiable Guardrails

- no direct cluster mutation in this plan
- no multi-repo write without validated change plan
- no repo write outside owned globs
- no source-of-truth ambiguity; fail closed
- every relationship edge and RCA claim should be explainable with provenance

## Final Note

The success condition is not "more scripts exist".

The success condition is:

- a live incident produces a durable dossier
- follow-up questions reuse that dossier
- the bot can explain why a relationship exists
- the bot can name the correct repo/path for a fix
- the bot can produce a safe, validated multi-repo plan before it writes anything
