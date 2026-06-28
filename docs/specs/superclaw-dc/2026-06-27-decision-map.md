# Superclaw Datacenter Architecture Decision Map

Date: 2026-06-27

Scope: analysis of the pasted Superclaw DC backlog. This is not a oneDAL workload note.

Update note: terminology in this first map is superseded by `rfc-01-tenant-isolation.md` where it conflicts. In particular, new Superclaw DC contracts must not use bare `tenant_id`; use `customer_tenant_id`, `org_id`, `isolation_cell_id`, `namespace_id`, `runtime_pool_id`, and `data_residency_region`.

## Executive Read

The pasted backlog is not a flat list of TODOs. It is a dependency knot around the Superclaw datacenter control spine:

```text
L3 workload identity/state
  -> L4 agent control/delegation/capability
  -> L5 channel identity/session/receipt
  -> L6 org policy/memory/lifecycle
  -> hard tenant boundary and audit
```

The architecture should not start by writing separate RFCs for every item. First write a spine RFC that fixes the shared vocabulary and transition points. Then split into narrower RFCs.

The highest-risk ambiguity is not "which component owns auth". It is that identity, tenant scope, data class, memory scope, capability attenuation, and receipt/audit are all currently named in different layers but not bound into one end-to-end transition model.

## Root Decisions

### D0. Canonical Request Context

Decision needed: define one canonical request context envelope carried across gateway, runtime, channel, policy evaluator, memory service, and receipt generation.

Minimum fields:

- `request_id`
- `trace_id`
- `org_id`
- `tenant_id`
- `canonical_principal_id`
- `channel_alias_id`
- `engagement_id`
- `agent_id`
- `agent_version`
- `runtime_id`
- `workload_svid`
- `session_id`
- `run_id`
- `capability_token_id`
- `delegation_chain`
- `data_classes`
- `tool_identity`
- `skill_manifest_id`
- `policy_epoch`
- `memory_scope`
- `receipt_id`

Why it is root: without this, L4 Biscuit, L5 three-key identity, L6 Cedar/AuthZEN, Mem0 scoping, OpenInference traces, and receipts all invent local names.

### D1. Hard-Tenant Enforcement Shape

Decision needed: use defense in depth, not one enforcement point.

Recommended shape:

```text
Gateway pre-check
  -> runtime admission sidecar
  -> PolicyEvaluator middleware
  -> data/memory service row/object guard
  -> receipt/audit verification
```

Each point has a different job:

- Gateway: reject impossible tenant/principal/channel bindings before workload dispatch.
- Runtime sidecar: bind SPIFFE/SVID workload identity to runtime and tenant.
- PolicyEvaluator middleware: authorize action with full chain context.
- Memory/data services: enforce hard tenant and data-class scope at read/write time.
- Receipt/audit: prove the path and decisions after the action.

Fail mode:

- Gateway unreachable to PDP: fail closed for cross-tenant/data-bearing actions.
- Policy cache stale: allow only explicitly cacheable low-risk read actions within TTL.
- Registry unreachable: fail closed for new skills/tools; allow pinned already-promoted objects only if attestation is fresh.

### D2. Identity Chain End-to-End

Decision needed: define transitions, not just token types.

Proposed chain:

```text
L3 SPIFFE SVID
  proves workload/runtime identity

L4 Biscuit capability token
  carries attenuated agent/tool/delegation claims

L5 channel alias binding
  resolves channel user/session to canonical principal

L6 Cedar/AuthZEN decision
  evaluates canonical principal + action + resource + context

Receipt/trace
  records all transitions and policy decisions
```

The chain must be explicit about:

- who mints the next token
- what previous proof is consumed
- what claims are copied, derived, or dropped
- how expiry/revocation propagates
- how replay is prevented

### D3. Data Class as Placement and Policy Input

Decision needed: data class must be a first-class scheduling and authorization input, not a post-hoc label.

Source of data class:

- declared by skill/tool manifest
- inferred by classifier
- inherited from memory/document provenance
- overridden by org policy only toward more restrictive classes

Initial taxonomy:

- `public`
- `internal`
- `confidential`
- `pii`
- `ip_confidential`
- `export_controlled`
- `credential_or_secret`
- `regulated_customer_data`

Placement effects:

- allowed runtime class
- allowed region
- TDX/Confidential Containers requirement
- memory store eligibility
- retention and erasure mode
- receipt redaction
- outbound channel eligibility

### D4. Org Memory Lifecycle Owns Promotion, Provenance, and Erasure

Decision needed: Mem0 remains a memory engine; Superclaw owns org lifecycle.

Org memory lifecycle service owns:

- `org_id` and hard-tenant scope
- promotion records
- artifact dependency graph
- read provenance
- write and edge transaction boundary
- leaver-aware cascade matrix
- crypto-erasure material mapping
- audit/receipt references

Mem0 can store `org_id` as metadata, but enforcement cannot rely only on optional metadata inside Mem0.

### D5. Receipt Is a Contract, Not UI Decoration

Decision needed: every meaningful agent action produces a receipt projection from trace + policy + state transitions.

Receipt must answer:

- who acted
- for whom
- under what delegation
- through what channel/session
- with which tool/skill
- on what data class
- with which policy decision
- what memory/data was read or written
- what was sent externally
- what was redacted
- how to revoke/replay/audit

## Dependency Graph

```text
D0 Canonical Request Context
  blocks:
    D2 Identity Chain
    D5 Receipt Definition
    OpenInference field contribution
    AuthZEN common property names

D1 Hard-Tenant Enforcement
  depends on:
    D0 Canonical Request Context
    D2 Identity Chain
    D3 Data Class
  blocks:
    Mem0 org_id enforcement
    Skills/MCP enforcement point
    Multi-tenancy T1/T2/T3 model

D2 Identity Chain
  depends on:
    SPIFFE/SPIRE root-CA ops
    Biscuit claim vocabulary
    L5 alias-binding profile
  blocks:
    A2A delegation/attenuation
    Cedar principal mapping
    outbound proactive semantics

D3 Data Class
  depends on:
    classifier contract
    manifest vocabulary
  blocks:
    placement
    crypto-erasure mode
    gateway hard-tenant decisions
    receipt redaction

D4 Org Memory Lifecycle
  depends on:
    D0 Canonical Request Context
    D1 Hard-Tenant Enforcement
    D3 Data Class
  blocks:
    promotion ritual
    cross-object PromotionEvent predicates
    leaver-aware purge
    artifact dependency graph

D5 Receipt Definition
  depends on:
    D0 Canonical Request Context
    D1 hard-tenant decision logs
    D2 identity transitions
    D4 memory provenance
  blocks:
    user-visible accountability
    OpenInference contribution
    pen-test evidence
```

## Prioritized RFC Set

### RFC-00: Superclaw DC Control Spine

Purpose: freeze shared envelope, ownership boundaries, identity transitions, policy call points, and receipt projection.

This must come first.

### RFC-01: Hard-Tenant Gateway Enforcement and Defense in Depth

Purpose: define gateway, sidecar, middleware, memory service, and audit enforcement responsibilities.

### RFC-02: Identity Chain and Capability Token Grammar

Purpose: define SPIFFE -> Biscuit -> channel alias -> Cedar principal transitions and claims.

### RFC-03: Org Memory Lifecycle Service

Purpose: define promotion, provenance, dependency graph, transaction boundary, leaver cascade, and hard tenant enforcement.

### RFC-04: Classification and Data-Class Placement Contract

Purpose: define classifier API, taxonomy, provider plugin shape, manifest declarations, and scheduler effects.

### RFC-05: L5 Single-Slot Channel and Three-Key Identity

Purpose: define channel abstraction, canonical principal/channel alias/engagement keys, binding events, proactive consent and retry.

### RFC-06: AI-Native Policy DSL over Cedar

Purpose: define what the DSL adds over Cedar, compilation model, invariant/routine tier split, and ReBAC lookup.

### RFC-07: Hybrid Bridge Offline Reconciliation

Purpose: define AI-PC <-> DC queue semantics, ordering, idempotency, conflict resolution, device attestation receipt, and reconnect.

## RFC-00 Draft Outline: Superclaw DC Control Spine

### Problem

Superclaw DC names many strong primitives: SPIFFE, Biscuit, A2A, channel alias binding, Cedar/AuthZEN, Mem0, OpenInference, in-toto predicates, data classes, and receipts. But the current backlog does not define the shared request context or the exact transition boundaries between layers.

Without the spine, every layer can be locally correct and globally ambiguous.

### Non-Goals

- Pick final UI for receipts.
- Specify every classifier provider.
- Define every Cedar policy.
- Replace Temporal/LangGraph/CrewAI/kagent internals.
- Solve every hybrid bridge conflict type.

### Components

- `Gateway`
- `RuntimeAdmissionSidecar`
- `AgentRuntimeAdapter`
- `PolicyEvaluator`
- `CapabilityTokenService`
- `AliasBindingResolver`
- `OrgMemoryLifecycleService`
- `Mem0Adapter`
- `MCPRegistry`
- `SkillRegistry`
- `Classifier`
- `PlacementScheduler`
- `ReceiptBuilder`
- `TraceCollector`
- `AuditLog`

### Canonical Envelope

Working name: `SuperclawRequestContext`.

Required sections:

```yaml
identity:
  org_id:
  tenant_id:
  canonical_principal_id:
  channel_alias_id:
  engagement_id:
  workload_svid:
  agent_id:
  agent_version:

delegation:
  capability_token_id:
  delegation_chain:
  attenuation_blocks:
  expires_at:

runtime:
  runtime_id:
  runtime_class:
  sandbox_id:
  session_id:
  run_id:
  temporal_workflow_id:
  runtime_thread_id:

action:
  action_type:
  tool_identity:
  tool_class:
  skill_manifest_id:
  data_classes:
  outbound_channel:

policy:
  policy_epoch:
  cedar_decision_id:
  authzen_request_id:
  rebac_snapshot_id:

memory:
  memory_scope:
  read_set:
  write_set:
  provenance_ids:

trace:
  trace_id:
  span_id:
  receipt_id:
```

### Layer Boundary Rules

#### L3 Runtime and Workload State

L3 owns:

- sandbox lifecycle
- workload SVID presentation
- runtime-local thread/process state
- cache/warm-pool state
- hibernate/resume mechanics

L3 exports:

- `workload_svid`
- `runtime_id`
- `runtime_class`
- `sandbox_id`
- `session_id`
- `run_id`
- runtime state checkpoint pointer
- in-flight tool-call status

L3 does not own:

- canonical principal identity
- org memory promotion
- final authorization policy
- channel alias truth

#### Temporal vs Runtime State

Temporal owns durable workflow intent:

- requested action
- checkpoints
- retry state
- workflow status
- external side-effect markers

Runtime owns agent thread state:

- model/tool context
- framework thread state
- local scratch
- in-flight tool invocation

Synchronization rule:

- Temporal records stable step boundaries.
- Runtime stores framework-native checkpoint blobs.
- External tool calls must be idempotency-keyed and recorded before retry.
- Resume replays from last committed Temporal step and rehydrates runtime checkpoint if compatible.

#### L4 Control Point

L4 owns:

- Agent CRD
- runtime adapter interface
- capability token mint/attenuation
- A2A dispatch profile
- chain budget reservation/accounting
- session continuity projection toward L5

L4 exports:

- runtime status conditions
- delegation chain
- chain budget events
- session continuity envelope
- policy-evaluable action context

#### L5 Channel

L5 owns:

- single-slot channel interface
- channel adapter cap mapping
- alias binding events
- canonical principal/channel alias/engagement model
- proactive outbound semantics
- user-facing receipt rendering

L5 exports:

- canonical principal resolution proof
- channel consent/reachability state
- engagement ID
- delivery receipts

#### L6 Org Plane

L6 owns:

- policy DSL and Cedar compilation
- invariant vs routine policy tier
- ReBAC integration
- PolicyEvaluator decision log
- org memory lifecycle
- promotion rituals
- registry trust metadata
- classification contract
- tenant isolation rules
- security ops

L6 exports:

- allow/deny decision with reason
- policy epoch
- memory provenance
- promotion attestations
- data class verdict
- erasure receipts

### Identity Transition Rules

1. Gateway receives channel/runtime request.
2. Alias resolver maps `channel_alias_id + engagement_id` to `canonical_principal_id`.
3. Gateway asks PolicyEvaluator for pre-dispatch decision.
4. Runtime admission sidecar verifies workload SVID and tenant binding.
5. CapabilityTokenService mints or attenuates Biscuit token for agent/tool action.
6. Agent runtime dispatches tool/sub-agent with attenuated token.
7. PolicyEvaluator evaluates each material action with full chain context.
8. Memory/data services enforce tenant and data class at object boundary.
9. ReceiptBuilder joins trace, policy, identity, memory, and channel events.

### Capability Token Grammar

Initial claim vocabulary:

- `org_id`
- `tenant_id`
- `act_for_user`
- `canonical_principal_id`
- `delegate_to`
- `agent_id`
- `agent_version`
- `tool_class`
- `tool_identity`
- `skill_manifest_id`
- `data_class`
- `memory_scope`
- `channel_scope`
- `budget_scope`
- `expires_at`
- `max_hops`
- `parent_token_id`
- `attenuation_reason`

Required attenuation semantics:

- Each hop can only remove or narrow claims.
- Each hop appends a block with issuer, subject, allowed action/resource/data class, expiry, and parent hash.
- Resolver verifies full chain before accepting a delegated action.
- Cross-tenant delegation is denied unless an explicit org-level policy grants it.

### Hard-Tenant Enforcement Path

Gateway checks:

- token tenant matches resolved principal tenant
- channel alias is active and not recycled-risk
- requested action is valid for data class
- registry trust metadata permits selected skill/tool

Runtime sidecar checks:

- SVID SAN maps to runtime identity
- runtime class allowed for tenant/data class
- workload belongs to same tenant namespace/pool
- no stale session reattachment across tenant

PolicyEvaluator checks:

- Cedar/AuthZEN decision over principal/action/resource/context
- ReBAC relationship if needed
- chain budget and delegation scope
- invariant tier before routine tier

Memory/data service checks:

- `org_id` and `tenant_id` at physical and logical boundary
- memory scope
- data class
- provenance and dependency graph
- write transaction edge boundary

Receipt/audit checks:

- all material decisions logged
- trace has required identity fields
- memory reads/writes have provenance references
- outbound delivery has channel consent proof

### STRIDE Seed Threat Model

#### Spoofing

- Spoofed channel alias maps to wrong canonical principal.
- Workload presents stale or wrong SVID.
- Sub-agent claims parent authority without valid attenuation chain.

Controls:

- signed alias binding events
- SVID attestation at runtime admission
- Biscuit chain verification
- receipt identity transition checks

#### Tampering

- Runtime mutates request context after gateway authorization.
- Memory write changes provenance/dependency graph separately from content.
- Registry trust metadata changed after promotion.

Controls:

- context hash in policy decision and receipt
- transactional memory write plus edge update
- signed in-toto PromotionEvent predicates

#### Repudiation

- Agent action cannot be tied to user/delegation/tool.
- Policy decision missing from trace.
- Offline bridge conflict resolved without audit.

Controls:

- mandatory receipt IDs
- policy decision log
- signed bridge reconciliation events

#### Information Disclosure

- Cross-tenant memory read.
- Channel adapter leaks confidential result to wrong alias.
- Receipt shows sensitive data class content.

Controls:

- hard tenant enforcement at service boundary
- alias binding freshness checks
- receipt redaction by data class

#### Denial of Service

- Chain budget exhaustion by sub-agent DAG.
- Warm pool starvation by high-cost runtime class.
- Registry/PDP outage blocks all work.

Controls:

- budget reservations
- per-tenant warm pool quotas
- fail-mode tiers and pinned trust cache

#### Elevation of Privilege

- Agent delegates broader capability than it received.
- Policy routine tier bypasses invariant tier.
- Runtime sidecar accepts non-confidential runtime for restricted data.

Controls:

- attenuation-only token semantics
- invariant tier first
- placement policy bound to data class

### Security/Ops Decisions Still Needed

#### SPIRE Root-CA Ops

Needs RFC section:

- root anchor storage
- intermediate rotation cadence
- workload SVID TTL
- multi-region trust domain
- disaster recovery
- compromised node/workload revocation
- audit evidence for CA rotations

#### Cryptographic Erasure

Needs RFC section:

- data class -> erasure mode matrix
- per-user/per-tenant/per-object key hierarchy
- crypto-shred vs delete-by-entity
- memory dependency graph cascade
- leaver-aware purge receipt
- retention exception policy

#### Substrate CVE Response

Needs RFC section:

- affected component inventory: Mem0, SPIRE, Cedar, NATS, gateway, runtime
- severity mapping
- freeze/disable knobs
- tenant blast-radius analysis
- forced re-attestation/re-promotion
- evidence required to re-enable

## Decision Matrix by Backlog Cluster

### L3 Workload Primitive

| Item                               | Classification | Depends on                   | Output                              |
| ---------------------------------- | -------------- | ---------------------------- | ----------------------------------- |
| checkpoint/resume during tool-call | RFC-00 section | Temporal/runtime split       | state ownership + idempotency rules |
| Temporal vs runtime state          | RFC-00 root    | none                         | durable vs thread state boundary    |
| TDX runtimeClass examples          | RFC-04/RFC-01  | data class placement         | runtimeClass profile contribution   |
| SandboxWarmPool for agents         | RFC-00/RFC-01  | runtime state + tenant pools | warm state contract                 |

### Backlog Matrix: L4 Control Point

| Item                          | Classification    | Depends on           | Output                       |
| ----------------------------- | ----------------- | -------------------- | ---------------------------- |
| Agent CRD shape               | RFC-00/RFC-01     | runtime state/status | CRD fields/status conditions |
| kagent vs stack-native facade | architecture fork | Agent CRD shape      | facade decision              |
| A2A delegation attenuation    | RFC-02            | capability grammar   | A2A extension profile        |
| Biscuit at dispatch           | RFC-02            | capability grammar   | token claims/blocks          |
| chain budgets                 | RFC-02/RFC-06     | delegation DAG       | reservation/accounting model |
| Session Continuity Record     | RFC-00/RFC-05     | L4/L5 boundary       | canonical envelope           |
| capability-token grammar      | RFC-02 root       | D0                   | claim vocabulary             |

### Backlog Matrix: L5 Channel

| Item                            | Classification | Depends on             | Output                     |
| ------------------------------- | -------------- | ---------------------- | -------------------------- |
| single-slot channel abstraction | RFC-05         | receipt + identity     | core adapter interface     |
| three-key identity model        | RFC-05/RFC-00  | alias resolver         | key lifecycle              |
| alias-binding events            | RFC-05         | Shared Signals profile | signed event schema        |
| outbound proactive semantics    | RFC-05/RFC-06  | consent + policy       | retry/opt-out/reachability |
| provisioning lifecycle UX       | RFC-05         | binding events         | enrollment flows           |
| per-user/org config promotion   | RFC-03/RFC-05  | promotion ritual       | conflict resolution        |
| Receipt View Definition         | RFC-00/RFC-05  | trace/policy/memory    | portable receipt fields    |

### Backlog Matrix: L6 Org Plane

| Item                         | Classification | Depends on             | Output                      |
| ---------------------------- | -------------- | ---------------------- | --------------------------- |
| AI-native DSL over Cedar     | RFC-06         | D0/D2/D3               | DSL semantics/compiler      |
| invariant vs routine tier    | RFC-06         | threat model           | tier routing criteria       |
| ReBAC integration timing     | RFC-06         | latency budget         | PDP/context lookup rule     |
| PolicyEvaluator decision-log | RFC-00/RFC-06  | receipt contract       | event schema                |
| org memory lifecycle service | RFC-03 root    | D1/D3                  | service design              |
| org_id scope for Mem0        | RFC-03/RFC-01  | hard tenant boundary   | adapter/enforcement design  |
| promotion ritual seven-step  | RFC-03         | PromotionEvent         | state machine               |
| cross-object PromotionEvent  | RFC-03         | in-toto schema         | predicate family            |
| MCP Registry trust metadata  | RFC-03/RFC-01  | enforcement point      | fields/resources            |
| Skills/MCP enforcement point | RFC-01/RFC-03  | registry trust         | fail modes                  |
| identity chain end-to-end    | RFC-02 root    | D0                     | transition spec             |
| TraT extension               | RFC-02/RFC-06  | identity/action fields | draft target decision       |
| AuthZEN common names         | RFC-00/RFC-06  | D0                     | property names              |
| classification contract      | RFC-04 root    | D3                     | API/taxonomy/provider shape |

### Hybrid Bridge

| Item                             | Classification | Depends on                  | Output                  |
| -------------------------------- | -------------- | --------------------------- | ----------------------- |
| offline reconciliation           | RFC-07         | memory lifecycle + identity | queue/conflict protocol |
| device attestation receipt       | RFC-07/RFC-02  | SPIRE + TPM policy          | receipt format          |
| NATS subject hierarchy           | RFC-07/RFC-01  | tenant model                | subject namespace       |
| session reattach via Mem0 run_id | RFC-07/RFC-03  | run_id/session semantics    | reconnect flow          |

### Data Classes and Placement

| Item                          | Classification | Depends on            | Output               |
| ----------------------------- | -------------- | --------------------- | -------------------- |
| data class as placement input | RFC-04 root    | classifier + manifest | scheduler contract   |
| data-class taxonomy           | RFC-04 root    | policy requirements   | canonical vocabulary |

### Observability and Metrics

| Item                          | Classification    | Depends on            | Output               |
| ----------------------------- | ----------------- | --------------------- | -------------------- |
| N3a Xeon offload percent      | metrics RFC later | placement/routing     | methodology          |
| N3b task success percent      | metrics RFC later | bot-specific outcomes | success definitions  |
| trace propagation L3-L6       | RFC-00            | canonical context     | OpenInference fields |
| perf regression gate criteria | metrics RFC later | task success/offload  | thresholds/windows   |

### Multi-Tenancy

| Item                            | Classification | Depends on              | Output                    |
| ------------------------------- | -------------- | ----------------------- | ------------------------- |
| T1/T2/T3 isolation model        | RFC-01         | data class/tenant model | storage/runtime topology  |
| hard-tenant gateway enforcement | RFC-01 root    | D0/D2/D3                | defense-in-depth contract |

### Security

| Item                   | Classification      | Depends on                | Output             |
| ---------------------- | ------------------- | ------------------------- | ------------------ |
| STRIDE threat model    | RFC-00/RFC-01 seed  | all root decisions        | pen-test scope     |
| SPIRE root-CA ops      | RFC-02/security ops | identity chain            | CA operations spec |
| crypto erasure         | RFC-03/security ops | data class + memory graph | purge guarantees   |
| substrate CVE response | security ops RFC    | component inventory       | incident playbook  |

## Implementation Gates

### Gate A: Spine Consistency

Pass condition:

- one canonical envelope covers L3-L6
- every layer declares ownership and export fields
- identity transition chain is unambiguous
- policy/receipt consume same field names

### Gate B: Hard-Tenant Safety

Pass condition:

- tenant scope checked at gateway, runtime, policy, memory/data boundary
- fail modes are explicit
- cross-tenant action has no default allow path
- audit can prove enforcement occurred

### Gate C: Delegation Safety

Pass condition:

- capability grammar supports attenuation only
- max hops and expiry enforced
- resolver verifies parent chain
- sub-agent DAG budget rolls up

### Gate D: Memory Lifecycle Safety

Pass condition:

- org memory lifecycle owns promotion/provenance/erasure
- Mem0 metadata alone is not enforcement boundary
- write+edge transaction is atomic
- leaver cascade matrix is defined per data class

### Gate E: Receipt/Audit Completeness

Pass condition:

- user-visible receipt derives from trace and policy logs
- policy decision ID included
- memory read/write provenance included
- outbound channel consent and delivery state included
- redaction follows data class

### Gate F: Security Review Scope

Pass condition:

- STRIDE threats mapped to controls
- SPIRE root-CA ops defined
- crypto-erasure guarantee defined by data class
- substrate CVE response has owner/runbook

## Recommended Next Action

Write RFC-00 first.

Proposed title:

```text
RFC-00: Superclaw DC Control Spine
Identity, tenancy, policy, memory, and receipt boundaries across L3-L6
```

Suggested acceptance criteria:

- includes `SuperclawRequestContext`
- defines L3/L4/L5/L6 ownership boundaries
- defines identity transition chain
- defines hard-tenant enforcement path
- defines PolicyEvaluator call points
- defines receipt source fields
- seeds STRIDE model
- lists child RFCs and what each owns

Do not start with the Cedar DSL, channel UX, or MCP registry fields. Those depend on the shared envelope and identity/tenant/data-class model.
