# RFC-00: Superclaw DC Control Spine

Status: draft

Date: 2026-06-27

## Summary

Superclaw DC needs one control spine across L3-L6 before individual designs for Cedar DSL, channel UX, Mem0 org lifecycle, A2A attenuation, MCP registry trust, or hybrid bridge can stabilize.

This RFC defines the shared request context, layer ownership, identity transitions, tenant enforcement points, policy decision points, and receipt source fields.

Clarification pass: see `reports/superclaw-dc/2026-06-27-clarifications.md`. Current OpenClaw primitives are useful hook points, but gateway scopes, channel allowlists, platform receipts, plugin-node capabilities, and local memory event logs are not DC hard-tenancy substitutes.

## Problem

The current architecture backlog names the right primitives but leaves their boundaries open:

- L3 has SPIFFE/SVID, runtime state, hibernate/resume, warm pools, and TDX runtime classes.
- L4 has Agent CRD, runtime adapters, A2A delegation, Biscuit tokens, chain budgets, and session continuity.
- L5 has single-slot channels, channel aliases, three-key identity, proactive outbound semantics, and receipts.
- L6 has Cedar/AuthZEN policy, ReBAC, org memory lifecycle, promotion, registry trust metadata, classification, and security ops.

Each primitive is reasonable locally. The missing piece is the end-to-end transition contract:

- how channel identity becomes canonical principal
- how workload identity becomes agent/runtime authority
- how capability tokens are minted and attenuated
- how data class changes placement and policy
- how memory scope is enforced
- how policy decisions become receipts
- how customer-tenant and isolation-cell boundaries are defended at multiple points

## Non-Goals

- Define every Cedar policy.
- Define final receipt UI.
- Choose kagent vs stack-native facade.
- Replace Temporal, LangGraph, CrewAI, or kagent internals.
- Specify every classifier implementation.
- Fully solve offline hybrid bridge reconciliation.

## Terms

- **Canonical principal**: org-level user/service identity used by policy.
- **Channel alias**: identity as seen by Slack, Teams, Telegram, email, voice, Rasa, LiveKit, or another channel.
- **Engagement ID**: channel-specific conversation/session binding.
- **Workload SVID**: SPIFFE-issued runtime/workload identity proof.
- **Capability token**: attenuable token, initially Biscuit-shaped, used for agent/tool/sub-agent authority.
- **Request context**: canonical envelope carried across gateway, runtime, policy, memory, channel, and receipt.
- **Material action**: any action that reads/writes scoped data, calls an external tool, delegates to sub-agent, sends outbound message, changes memory, or changes org-controlled artifacts.

## Canonical Request Context

Working name: `SuperclawRequestContext`.

Required schema:

```yaml
schema_version: superclaw.request_context.v0

request:
  request_id:
  trace_id:
  parent_request_id:
  created_at:

identity:
  org_id:
  customer_tenant_id:
  isolation_cell_id:
  runtime_pool_id:
  namespace_id:
  data_residency_region:
  canonical_principal_id:
  principal_type: user | service | agent
  channel_alias_id:
  channel_id:
  engagement_id:
  alias_binding_event_id:

runtime:
  workload_svid:
  spiffe_trust_domain:
  runtime_id:
  runtime_kind:
  runtime_class:
  sandbox_id:
  session_id:
  run_id:
  temporal_workflow_id:
  runtime_thread_id:

agent:
  agent_id:
  agent_version:
  agent_card_id:
  runtime_adapter:

delegation:
  capability_token_id:
  parent_token_id:
  delegation_chain:
  attenuation_blocks:
  max_hops:
  expires_at:

action:
  action_type:
  action_id:
  tool_identity:
  tool_class:
  skill_manifest_id:
  mcp_server_id:
  resource_type:
  resource_id:
  outbound_channel:

data:
  declared_data_classes:
  inferred_data_classes:
  effective_data_classes:
  classifier_version:
  placement_constraints:

policy:
  policy_epoch:
  invariant_decision_id:
  routine_decision_id:
  authzen_request_id:
  cedar_principal:
  cedar_action:
  cedar_resource:
  rebac_snapshot_id:

memory:
  memory_scope:
  mem0_user_id:
  mem0_agent_id:
  mem0_run_id:
  org_memory_transaction_id:
  read_set:
  write_set:
  provenance_ids:

budget:
  chain_budget_id:
  reservation_id:
  parent_reservation_id:
  cost_center:

receipt:
  receipt_id:
  receipt_visibility:
  redaction_profile:
```

## Layer Ownership

### L3: Workload Primitive

Owns:

- sandbox lifecycle
- workload SVID presentation
- runtime-local thread/process state
- hibernate/resume mechanics
- warm pool/cache state
- runtimeClass selection execution

Exports:

- `workload_svid`
- `runtime_id`
- `runtime_class`
- `sandbox_id`
- `session_id`
- `run_id`
- checkpoint pointer
- in-flight tool-call marker

Does not own:

- canonical principal identity
- alias truth
- final policy decision
- org memory promotion
- user-visible receipt semantics

### L4: Control Point

Owns:

- Agent CRD
- runtime adapter interface
- capability token minting/attenuation
- A2A delegation profile
- sub-agent dispatch DAG
- chain budget reservation/accounting
- Session Continuity Record projection toward L5

Exports:

- Agent status conditions
- delegation chain
- budget events
- runtime projection fields
- policy-evaluable material action context

### L5: Channel

Owns:

- single-slot channel abstraction
- channel adapter capability mapping
- canonical principal/channel alias/engagement model
- alias binding event profile
- proactive outbound consent/retry/opt-out
- user-facing receipt view

Exports:

- alias resolution proof
- engagement ID
- channel consent state
- channel reachability state
- delivery receipt

### L6: Org Plane

Owns:

- policy DSL and Cedar compilation
- invariant vs routine policy tier split
- ReBAC lookup or snapshot injection
- PolicyEvaluator decision logs
- org memory lifecycle service
- promotion rituals and PromotionEvent predicates
- MCP/skill registry trust metadata
- classification contract
- customer tenant, org, and isolation-cell model
- security ops: STRIDE, SPIRE CA, erasure, CVE response

Exports:

- allow/deny decisions
- policy epoch
- data class verdict
- memory provenance
- promotion attestation
- erasure receipt
- audit events

## Main Flow: Inbound Agent Action

1. Channel adapter receives inbound event.
2. If the adapter is outside the gateway trust boundary, L5 presents a signed `AliasAssertion`.
3. Gateway verifies alias proof, replay window, binding epoch, issuer, audience, and route-to-cell mapping.
4. Gateway builds initial `SuperclawRequestContext`.
5. CapabilityTokenService mints the root capability for this request.
6. Gateway calls PolicyEvaluator pre-dispatch with context and root capability hash.
7. PlacementScheduler chooses runtime class using isolation cell, runtime pool, data class, policy, and availability.
8. L3 runtime admission verifies workload SVID and runtime/cell binding.
9. L4 runtime adapter starts or resumes agent session.
10. Agent proposes material action.
11. Runtime adapter converts proposal into policy-evaluable action context.
12. PolicyEvaluator checks invariant tier, then routine tier.
13. Tool/memory/data service enforces org/customer-tenant/isolation-cell and data class at boundary.
14. TraceCollector records material spans and decisions.
15. ReceiptBuilder commits `ActionReceipt`; channel delivery may additionally produce `MessageReceipt`.

## Main Flow: Sub-Agent Delegation

1. Parent agent requests delegation.
2. L4 computes child action scope and budget reservation.
3. CapabilityTokenService attenuates parent token.
4. Resolver verifies parent token chain and max hop count.
5. Gateway/sidecar repeats org/customer-tenant/isolation-cell/runtime checks for child runtime.
6. Child action policy is evaluated with full `delegation_chain`.
7. Budget spend rolls up to parent chain budget.
8. Receipt records parent/child delegation and attenuation blocks.

## Main Flow: Memory Write

1. Agent proposes memory write with effective data class and provenance.
2. PolicyEvaluator authorizes write for principal, org, customer tenant, isolation cell, memory scope, data class.
3. OrgMemoryLifecycleService writes `memory_write_intent` in its durable store.
4. Mem0Adapter writes memory under scoped metadata and records external write ID.
5. OrgMemoryLifecycleService writes provenance and dependency edges.
6. Reconciler repairs or blocks incomplete intent/edge/write states.
7. ReceiptBuilder records memory write, provenance IDs, outbox state, and erasure class.

Rule: Mem0 metadata is not the hard enforcement boundary. OrgMemoryLifecycleService and gateway/service-level checks are.

Default atomicity model: recoverable outbox, not cross-store 2PC. A single transaction boundary is allowed only if Mem0 storage and org graph storage are proven to be the same datastore.

## Hard-Tenant Enforcement

### Gateway

Checks:

- request org/customer tenant/isolation cell matches alias binding and gateway route
- canonical principal is active in org/customer tenant
- root capability token customer tenant/org/isolation cell matches context
- requested skill/tool is promoted or allowed for org/customer tenant
- requested data class can leave the channel/runtime boundary

Fail mode:

- fail closed for cross-isolation-cell, cross-customer-tenant, and data-bearing actions
- allow only explicitly configured low-risk health/status operations if PDP unavailable

### Runtime Admission Sidecar

Checks:

- workload SVID trust domain
- SAN maps to runtime identity
- runtime belongs to isolation-cell namespace and runtime pool
- runtime class satisfies effective data class
- session/run reattach is same org/customer tenant/isolation cell and same principal/delegation chain

Fail mode:

- fail closed on SVID mismatch, expired SVID, wrong isolation-cell pool, or runtimeClass downgrade

### PolicyEvaluator Middleware

Checks:

- invariant tier policies first
- routine tier policies second
- ReBAC relationship lookup or snapshot validity
- decision cache key includes principal, org, customer tenant, isolation cell, action, resource, effective data classes, capability hash, policy epoch, alias binding epoch, revocation epoch, and classification epoch
- allow-decision TTL and stale-decision invalidation
- chain budget reservation
- capability token attenuation

Fail mode:

- fail closed for writes, external sends, delegation, cross-resource memory reads
- bounded allow with cached decision only for explicitly cacheable reads and only while all epochs match

### Memory/Data Boundary

Checks:

- `org_id`
- `customer_tenant_id`
- `isolation_cell_id`
- `canonical_principal_id` or service principal
- memory scope
- data class
- provenance edge constraints

Fail mode:

- fail closed if context missing or mismatch
- never rely only on caller-provided metadata

## Capability Token Grammar

Initial Biscuit-like vocabulary:

```text
org_id
customer_tenant_id
isolation_cell_id
runtime_pool_id
namespace_id
act_for_user
canonical_principal_id
delegate_to
agent_id
agent_version
tool_identity
tool_class
skill_manifest_id
mcp_server_id
data_class
memory_scope
channel_scope
budget_scope
expires_at
max_hops
parent_token_id
attenuation_reason
```

Rules:

- Initial/root token is minted by gateway-facing CapabilityTokenService after alias proof and context creation, before L4 dispatch.
- L4 may attenuate tokens for sub-agent dispatch only after receiving the root token.
- Tokens are attenuation-only after initial mint.
- Every delegation appends a block.
- Every block includes issuer, subject, action/resource/data class, expiry, parent hash.
- Resolver validates full chain before action.
- Token expiry cannot exceed parent expiry.
- Child token data class cannot be less restrictive than parent.
- Cross-isolation-cell token use is denied. Cross-customer-tenant delegation is denied unless explicit org/MSP policy grants it and a new root token is minted for the target boundary.

## Policy Tiers

### Invariant Tier

Runs in Rust sidecar or equivalently hardened path.

Contains:

- customer-tenant and isolation-cell boundary
- runtimeClass/data-class invariant
- no unpromoted skill/tool for restricted data
- no channel send without consent
- no delegation beyond max hop/budget
- no memory read/write outside org/customer-tenant/isolation-cell scope

### Routine Tier

Can run in Cedar-Go/in-process path if acceptable.

Contains:

- team/project permissions
- role-based approvals
- time-window constraints
- quota preferences
- per-user config
- non-critical UX policy

Routing criterion:

- If violation can cross customer-tenant or isolation-cell boundary, leak restricted data, bypass identity, mutate org memory, or execute untrusted tool, it belongs to invariant tier.

## Receipt Source Fields

Every material action receipt should include source references:

Receipt split:

- `ActionReceipt`: policy/security/provenance/tamper-evident audit receipt for a material action.
- `MessageReceipt`: platform delivery receipt from channel outbound. It can be linked from `ActionReceipt`, but it is not sufficient for audit by itself.

- `receipt_id`
- `trace_id`
- `request_id`
- `org_id`
- `customer_tenant_id`
- `isolation_cell_id`
- `canonical_principal_id`
- `channel_alias_id`
- `engagement_id`
- `agent_id`
- `agent_version`
- `runtime_id`
- `workload_svid`
- `capability_token_id`
- `delegation_chain`
- `tool_identity`
- `skill_manifest_id`
- `effective_data_classes`
- `policy_decision_ids`
- `memory_read_set`
- `memory_write_set`
- `provenance_ids`
- `outbound_delivery_state`
- `linked_message_receipt_id`
- `prev_receipt_hash`
- `receipt_hash`
- `signed_by`
- `redaction_profile`

## Failure Modes

### In-Flight Tool Call During Pause

Durable owner:

- Temporal owns step intent and retry marker.

Runtime owner:

- runtime stores framework checkpoint and in-flight marker.

Rule:

- do not resume raw process unless runtime explicitly supports it safely.
- reissue idempotent tool call from last committed step.
- external side effects require idempotency key and receipt event.

### Alias Binding Recycled Risk

Rule:

- recycled-risk alias cannot authorize data-bearing actions until reverified.
- existing proactive sends pause.
- receipt must record alias binding event ID and status.

### Registry Unreachable

Rule:

- deny new skill/tool execution for restricted data.
- allow pinned promoted artifacts only if trust metadata TTL is fresh.

### PDP Unavailable

Rule:

- deny writes, outbound sends, delegation, memory reads with restricted data.
- allow only explicitly cached low-risk reads within TTL.

### SPIRE CA Rotation

Rule:

- runtime admission accepts overlapping old/new intermediates during rotation window.
- new sessions use new SVID chain.
- old chain revocation forces runtime re-attestation.

## STRIDE Baseline

### Spoofing

Threats:

- forged channel alias
- stale SVID
- fake sub-agent authority

Required controls:

- signed alias events
- SVID admission check
- capability chain verification

### Tampering

Threats:

- request context mutation after authorization
- memory content/provenance split write
- registry metadata mutation

Required controls:

- context hash in policy decision
- memory write and edge transaction
- signed promotion predicates

### Repudiation

Threats:

- missing policy decision
- unlinked delegation
- offline bridge conflict without audit

Required controls:

- mandatory decision logs
- receipt IDs
- signed reconciliation events

### Information Disclosure

Threats:

- cross-customer-tenant or cross-isolation-cell memory read
- wrong channel alias delivery
- receipt over-discloses restricted data

Required controls:

- service-bound org/customer-tenant/isolation-cell checks
- alias freshness checks
- receipt redaction by data class

### Denial of Service

Threats:

- sub-agent budget explosion
- warm pool exhaustion
- PDP/registry outage

Required controls:

- chain budget reservation
- per-customer-tenant and per-isolation-cell runtime quotas
- pinned trust cache with fail-closed rules

### Elevation of Privilege

Threats:

- broadening delegation
- routine policy bypass of invariant policy
- runtimeClass downgrade for restricted data

Required controls:

- attenuation-only token rules
- invariant tier first
- data-class placement enforcement

## Child RFCs

This RFC intentionally blocks detailed child designs until the spine is accepted.

Required child RFCs:

- RFC-01: Hard-Tenant Gateway Enforcement and Defense in Depth
- RFC-02: Identity Chain and Capability Token Grammar
- RFC-03: Org Memory Lifecycle Service
- RFC-04: Classification and Data-Class Placement Contract
- RFC-05: L5 Single-Slot Channel and Three-Key Identity
- RFC-06: AI-Native Policy DSL over Cedar
- RFC-07: Hybrid Bridge Offline Reconciliation

## Acceptance Gates

This RFC is acceptable when:

- one `SuperclawRequestContext` covers L3-L6
- every layer has clear ownership and exports
- identity transitions are explicit
- hard-tenant and isolation-cell enforcement has at least gateway, runtime, policy, and data/memory checks
- capability tokens are attenuation-only
- data class affects placement, policy, receipt, and erasure
- receipt can be derived from trace and decision logs
- STRIDE baseline maps threats to controls

## Open Questions

- Is `org_id` always inside exactly one `customer_tenant_id`, or can MSP/admin principals span multiple customer tenants?
- Is Superclaw DC deployed as one gateway per `isolation_cell_id`, or a gateway fleet with cell-aware routing?
- Which component owns alias binding signing keys?
- Does PolicyEvaluator call ReBAC live, or does gateway inject relationship snapshot into context?
- Is CapabilityTokenService gateway-owned or a separate security-plane service? It is not L4-owned for root mint.
- What is the exact threshold for invariant vs routine policy routing?
- Are receipt IDs user-visible stable IDs or internal audit IDs with user projection IDs?
- Should Mem0 `run_id` be canonical or wrapped by Superclaw `run_id`?
- Which data classes require TDX/Confidential Containers by default?
- What is the first upstream contribution target: A2A attenuation, OpenInference fields, AuthZEN names, or MCP registry trust metadata?
