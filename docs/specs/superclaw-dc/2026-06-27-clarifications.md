# Superclaw DC Clarification Pass

Date: 2026-06-27

Scope: follow-up on the RFC-00 review blockers. I checked the current OpenClaw tree as a concrete reference implementation, then turned the review findings into implementation decisions and contract sketches.

Reference tree checked:

- `/home/openclaw/.openclaw/workspace-openclaw-dev/pr-90101-rebase`
- branch: `draft/runtime-self-context-plan`
- HEAD: `d8b986eb329cebe2d0625f4ca1addc29cd1876f6`

## Result

Verdict: the review blockers are real. Current OpenClaw has useful primitives for gateway auth, scopes, channel inbound/outbound, receipts, memory events, task flows, and plugin capabilities, but those primitives are not sufficient for Superclaw DC hard tenancy without a new control spine contract.

This pass clarifies six details:

1. Tenant isolation cannot use existing gateway operator scopes.
2. L5 channel identity must either be inside the gateway trust boundary or present a signed alias assertion.
3. The first capability token must be minted before L4 dispatch, not by L4 after dispatch.
4. Current message receipts are delivery receipts, not security/audit receipts.
5. Current memory event logs are local diagnostic journals, not org-memory transactional provenance.
6. PDP/cache semantics are absent and must be a first-class RFC-00 contract.

## Evidence

### Gateway scope is not hard tenancy

`docs/gateway/operator-scopes.md:10-14` says operator scopes are a control-plane guardrail inside one trusted Gateway operator domain, not hostile multi-tenant isolation, and recommends separate Gateways under separate OS users or hosts for strong separation.

`docs/gateway/operator-scopes.md:110-119` says shared gateway token/password auth is trusted operator access and shared-secret bearer auth restores full operator default scopes even when the caller sends narrower scopes.

Clarification:

- Existing `operator.read/write/admin/...` scopes are not the Superclaw tenant isolation model.
- RFC-00 must split:
  - `customer_tenant_id`: billing/admin/customer boundary.
  - `org_id`: org-plane principal namespace.
  - `isolation_cell_id`: hard runtime/data isolation boundary.
  - `runtime_pool_id`: scheduling pool inside an isolation cell.
  - `namespace_id`: K8s/control-plane namespace.
  - `data_residency_region`: placement/legal boundary.
- Hard tenant checks use `isolation_cell_id`, not bare `tenant_id`.
- Cross-org MSP cases require explicit `customer_tenant_id -> org_id[] -> isolation_cell_id[]` mapping. No implicit shared-gateway trust.

Proposed invariant:

```text
No request may reach L4 dispatch unless:
  context.customer_tenant_id is resolved
  context.org_id is resolved
  context.isolation_cell_id is resolved
  context.namespace_id is resolved
  all four match the gateway routing table for the authenticated ingress
```

### Gateway/L5 trust boundary needs signed alias proof

`docs/gateway/trusted-proxy-auth.md:12-14` warns that trusted-proxy auth delegates authentication entirely to the reverse proxy.

`docs/gateway/trusted-proxy-auth.md:41-45` says OpenClaw only verifies trusted proxy source and extracts identity from configured headers.

`docs/gateway/trusted-proxy-auth.md:62-70` says proxy auth policy and `allowUsers` become effective access control.

`docs/plugins/sdk-channel-inbound.md:10-19` models channel receive as `platform event -> inbound facts/context -> agent reply -> message delivery`.

`docs/plugins/sdk-channel-inbound.md:31-36` says inbound helpers project normalized channel facts into prompt/session context and run ingest/classify/preflight/resolve/record/dispatch/finalize.

`docs/channels/access-groups.md:10-15` says access groups are named sender lists and do not grant access by themselves.

`docs/channels/access-groups.md:45` says OpenClaw does not translate sender IDs between channels.

`docs/channels/access-groups.md:184-189` says access groups are allowlist aliases, not roles.

Clarification:

- Current channel adapters normalize platform facts. They do not establish canonical principal identity.
- Current trusted-proxy mode gives a pattern for ingress identity, but it is header/IP trust, not a portable alias-binding proof.
- For Superclaw DC, an L5 adapter has only two valid shapes:
  - inside boundary: adapter runs inside gateway-controlled trust boundary; gateway owns canonicalization.
  - outside boundary: adapter sends a signed alias assertion to gateway; gateway verifies it before creating `SuperclawRequestContext`.

Proposed `AliasAssertion` v0:

```json
{
  "iss": "l5-adapter:telegram:prod",
  "aud": "superclaw-gateway:cell-usw2-a",
  "exp": 1782600000,
  "jti": "alias-event-01J...",
  "channel": "telegram",
  "channel_account_id": "bot-prod-1",
  "channel_conversation_id": "-1003759657220",
  "channel_sender_id": "293894843",
  "engagement_id": "eng_01J...",
  "canonical_principal_id": "principal_01J...",
  "alias_binding_event_id": "abe_01J...",
  "binding_epoch": 42
}
```

Required gateway checks:

- issuer allowlisted for `(channel, account, isolation_cell_id)`;
- signature valid;
- `aud` matches gateway/cell;
- `exp` and `jti` pass replay window;
- `alias_binding_event_id` exists and is not superseded/revoked;
- resolved `canonical_principal_id` is allowed for `org_id`.

### First capability token is gateway/identity output, not L4 output

`src/gateway/plugin-node-capability.ts:94-97` mints opaque plugin-node capability tokens.

`src/gateway/plugin-node-capability.ts:11-15` and `:17-29` show these tokens are scoped to plugin-hosted node surfaces with TTL/storage metadata.

`docs/gateway/operator-scopes.md:63-91` makes device pairing records the durable source of approved roles/scopes.

`docs/plugins/architecture-internals.md:653-658` says plugin routes do not automatically get admin scope and gateway-auth routes have conservative scope behavior.

Clarification:

- Existing capability tokens are narrow opaque URL/surface tokens. They are not agent delegation tokens and do not carry attenuation semantics.
- L4 cannot be the first issuer because gateway needs a capability before accepting L4 dispatch.
- Correct order:
  1. Ingress authenticates request or verifies alias assertion.
  2. Gateway builds pre-token context.
  3. Gateway calls identity/capability issuer for initial root capability.
  4. Gateway calls PDP pre-dispatch with root capability hash.
  5. L4 receives context plus root capability.
  6. L4 may attenuate for sub-agent dispatch.

Proposed capability lifecycle gate:

```text
initial_mint:
  input: verified_alias_assertion | trusted_gateway_operator_identity
  output: root_capability
  issuer: superclaw-capability-issuer
  audience: l4-dispatch

attenuation:
  input: parent_capability + requested_child_scope
  output: child_capability
  rule: child_scope subset parent_scope, child_exp <= parent_exp

reattach:
  input: runtime checkpoint + capability handle
  rule: resume only if capability live, not revoked, and checkpoint isolation ids match
```

Must-fail tests:

- child scope exceeds parent scope;
- child expiry exceeds parent expiry;
- revoked parent resumes child runtime;
- token tenant/org/cell differs from checkpoint;
- replayed alias assertion mints a second root token.

### Receipt is currently platform delivery only

`docs/plugins/sdk-channel-outbound.md:14-17` says core owns queueing, durability, generic retry policy, hooks, receipts, and shared message tool; plugins own native sends and side effects.

`docs/plugins/sdk-channel-outbound.md:51-58` shows receipt creation from channel/message/conversation IDs.

`docs/plugins/sdk-channel-outbound.md:97-105` defines send outcomes: `sent`, `suppressed`, `partial_failed`, `failed`.

`src/channels/message/types.ts:49-61` defines raw platform receipt source fields.

`src/channels/message/types.ts:83-94` defines `MessageReceipt` as platform message IDs, parts, thread/reply IDs, edit/delete tokens, sent time, raw results.

Clarification:

- Current `MessageReceipt` proves platform delivery shape, not policy authorization, identity chain, data-class handling, or tamper evidence.
- RFC-00 should not overload `MessageReceipt`.
- Add a separate `ActionReceipt` / `SecurityReceipt` linked to platform receipt.

Proposed `ActionReceipt` v0:

```json
{
  "receipt_id": "ar_01J...",
  "action_id": "act_01J...",
  "trace_id": "tr_01J...",
  "context_hash": "sha256:...",
  "principal_id": "principal_01J...",
  "org_id": "org_01J...",
  "customer_tenant_id": "cust_01J...",
  "isolation_cell_id": "cell-usw2-a",
  "capability_hash": "sha256:...",
  "policy_decision_id": "pd_01J...",
  "data_classes_effective": ["internal"],
  "redaction_profile": "receipt-user-v1",
  "platform_receipt": {
    "channel": "telegram",
    "primaryPlatformMessageId": "11885"
  },
  "prev_receipt_hash": "sha256:...",
  "receipt_hash": "sha256:...",
  "signed_by": "spiffe://superclaw/cell-usw2-a/gateway"
}
```

Integration point:

- Current channel outbound hooks can carry this later, but RFC-00 should specify the security receipt independently from message delivery.

### Memory atomicity is not present in current memory host

`src/memory-host-sdk/events.ts:7-8` defines a workspace-relative JSONL audit log for memory recall, promotion, and dream events.

`src/memory-host-sdk/events.ts:41-55` defines `memory.promotion.applied`.

`src/memory-host-sdk/events.ts:82-93` appends one event to a JSONL log.

`src/memory-host-sdk/events.ts:96-111` treats malformed lines as best-effort diagnostics that must not break later status rendering.

Clarification:

- This is useful local memory telemetry, but it is not org-memory lifecycle enforcement.
- It has no tenant boundary, no graph edge transaction, no erasure state, no tamper-evident chain, and no Mem0 write coupling.
- RFC-00 must replace "same transaction boundary" with an implementable choice.

Proposed implementable default: outbox + reconciliation, not 2PC.

```text
memory_write_intent.created
  durable in org-memory DB before side effects

mem0.write.applied
  external write id recorded

graph_edges.applied
  provenance/dependency edges recorded

receipt.committed
  action receipt records final state

reconciler:
  retries stuck intents
  marks poison records
  emits audit gap events
  blocks reads when required edges are missing
```

Read invariant:

```text
Org memory read path returns only records with:
  state = active
  org_id match
  isolation_cell_id match or explicitly replicated
  data_class allowed by PDP
  provenance edge state = applied
  erasure_epoch <= reader_epoch
```

### PDP/cache semantics are absent

Search result:

- No current `PolicyEvaluator`, Cedar, Biscuit, `tenant_id`, `customer_tenant`, or `isolation_cell` contract exists in `docs`, `src`, `extensions`, or `qa`.
- Current policy-like surfaces are gateway method scopes, trusted tool policies, node-invoke policies, channel mention/allowlist policy, SSRF policy, and provider/runtime policy. They are local controls, not Superclaw DC PDP.

Relevant current docs:

- `docs/plugins/sdk-runtime.md:254-256` says node invoke policies run in Gateway after command allowlist checks and before forwarding to node.
- `docs/plugins/architecture-internals.md:653-658` says plugin route auth/scope behavior is conservative and explicit.

Clarification:

- RFC-00 must define the PDP request/response and cache contract before discussing Rust sidecar vs Cedar-Go.
- The policy implementation language is non-normative until invariant/routine semantics are stable.

Proposed `PolicyDecisionRequest` cache key fields:

```text
principal_id
org_id
customer_tenant_id
isolation_cell_id
action
resource_kind
resource_id
tool_identity
data_classes_effective
capability_hash
policy_epoch
alias_binding_epoch
revocation_epoch
classification_epoch
```

Cache rule:

```text
deny decisions may be cached briefly;
allow decisions require bounded TTL and epoch match;
missing PDP = fail closed for external side effects, memory writes, tenant routing, and sub-agent dispatch;
stale allow after revocation epoch change = invalid.
```

## Revised RFC-00 decisions

### D0: Replace `tenant_id`

Old: `tenant_id` as one overloaded hard-isolation key.

New: `SuperclawRequestContext` carries explicit tenant/isolation fields:

```json
{
  "principal_id": "principal_01J...",
  "org_id": "org_01J...",
  "customer_tenant_id": "cust_01J...",
  "isolation_cell_id": "cell-usw2-a",
  "runtime_pool_id": "pool-buildbot-prod",
  "namespace_id": "ns-org-prod-a",
  "data_residency_region": "us-west"
}
```

### D1: Gateway owns context creation

L5 can normalize channel events, but gateway owns canonical context creation.

L5 outside gateway boundary must present `AliasAssertion`.

Unsigned inbound channel facts may influence prompt/session context only after gateway context exists; they may not create `principal_id`.

### D2: Capability issuer owns root token

Root token issuer is `superclaw-capability-issuer`, called by gateway.

L4 owns attenuation for sub-agent dispatch only after root token exists.

### D3: Receipts split in two

`MessageReceipt`: platform delivery.

`ActionReceipt`: security/audit/provenance/tamper-evidence.

They are linked, not merged.

### D4: Org memory uses outbox transaction model

Default: single org-memory DB transaction for intent/edges/receipt metadata, with Mem0 external write reconciled through outbox.

Do not require cross-store "same transaction boundary" unless both stores are proven same datastore.

### D5: PDP contract precedes implementation tier

RFC-00 defines PDP API, decision event, cache key, TTL/epoch invalidation, and fail modes.

Rust sidecar vs Cedar-Go is an implementation note, not a normative split.

## Experiments to add next

1. Contract test: unsigned channel inbound event cannot produce `SuperclawRequestContext`.
2. Contract test: trusted proxy identity cannot set tenant/isolation fields outside routing table.
3. Token lifecycle test: child token cannot outlive/exceed parent.
4. PDP cache test: allow decision invalidates on `revocation_epoch` and `policy_epoch`.
5. Memory outbox test: Mem0 write success + graph write failure results in blocked reads until reconciliation.
6. Receipt test: platform send success without `ActionReceipt` is not sufficient for audited external action.

## Open Questions

1. Does Superclaw DC run one gateway per isolation cell, or a gateway fleet with cell-aware routing? Existing OpenClaw guidance points toward separate gateways for real separation.
2. Is `org_id` always inside exactly one `customer_tenant_id`, or can MSP/admin principals span multiple customer tenants?
3. Where is the alias-binding event registry: L5 identity service, L6 org plane, or shared identity service?
4. Is Mem0 authoritative storage or only a recall/index layer behind org-memory lifecycle service?
5. Which actions require `ActionReceipt`: all user-visible external actions, all memory writes, all tool calls, or only side-effectful actions?
