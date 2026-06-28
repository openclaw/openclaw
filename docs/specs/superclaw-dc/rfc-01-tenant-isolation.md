# RFC-01: Tenant and Isolation Model

Status: draft

Date: 2026-06-27

Depends on: `rfc-00-control-spine.md`

Evidence pass: `2026-06-27-clarifications.md`

## Summary

Superclaw DC must not use one overloaded `tenant_id`. The enforcement model needs separate names for customer ownership, org policy namespace, hard runtime/data isolation, K8s/runtime placement, and data residency.

This RFC defines the implementation-level shape for those identifiers, how gateway routing binds them, and which checks are fail-closed.

## Decision

Use this identity/isolation tuple in every material request:

```yaml
customer_tenant_id: cust_01J...
org_id: org_01J...
isolation_cell_id: cell-usw2-a
namespace_id: ns-org-prod-a
runtime_pool_id: pool-buildbot-prod
data_residency_region: us-west
```

Never use bare `tenant_id` in new Superclaw DC contracts.

## Identifier Meanings

### `customer_tenant_id`

Commercial/admin boundary. One paying customer, enterprise account, or MSP-managed customer.

Owns:

- billing/account administration
- customer-level administrators
- contractual data boundary
- top-level quota envelope
- emergency suspension

Does not by itself select a runtime.

### `org_id`

Policy and memory namespace. This is the Cedar/AuthZEN principal/resource namespace and the org-memory lifecycle namespace.

Owns:

- canonical principals
- org memory records
- skills/MCP promotion state
- org policy bundles
- alias-binding registry entries

Usually belongs to one `customer_tenant_id`, but MSP scenarios may introduce admin principals that can act across several customer tenants. Cross-customer action must be explicit policy, not default inheritance.

### `isolation_cell_id`

Hard isolation boundary. This is the primary fail-closed boundary for runtime, data, memory, and network egress.

Owns:

- gateway route admission boundary
- runtime admission boundary
- storage partition boundary
- KMS/key boundary
- network policy boundary
- Confidential Containers/TDX placement boundary

Cross-cell execution is denied unless the request is explicitly re-issued into another cell with a new root capability.

### `namespace_id`

K8s/control-plane namespace inside an isolation cell.

Owns:

- Kubernetes namespace
- service account/SPIFFE mapping
- NetworkPolicy scope
- resource quota scope
- workload admission scope

### `runtime_pool_id`

Scheduling pool inside an isolation cell and namespace.

Owns:

- warm pool membership
- runtimeClass defaults
- GPU/Xeon/offload capacity class
- tenant/org quota sub-bucket
- pre-attached memory/SVID policy

### `data_residency_region`

Legal/placement region. This can constrain isolation cell selection and data replication.

Owns:

- allowed storage locations
- allowed outbound channel regions
- approved model/provider endpoints
- replication and backup policy

## Gateway Routing Table

Gateway must have an authoritative routing table before it can construct `SuperclawRequestContext`.

Example:

```yaml
gateway_id: gw-usw2-a-01
gateway_trust_domain: spiffe://superclaw/gateway/usw2-a
served_cells:
  - isolation_cell_id: cell-usw2-a
    data_residency_region: us-west
    allowed_customer_tenants:
      - cust_01JACME
    namespace_routes:
      org_01JBUILD:
        namespace_id: ns-build-prod-a
        runtime_pools:
          - pool-buildbot-prod
          - pool-supportbot-prod
```

Admission rule:

```text
gateway can create context only if:
  customer_tenant_id in served_cells[].allowed_customer_tenants
  org_id maps to namespace_id under that customer tenant
  isolation_cell_id is served by this gateway
  runtime_pool_id belongs to namespace_id
  data_residency_region matches the served cell or explicit replication policy
```

## Deployment Shapes

### Shape A: Gateway Per Isolation Cell

One gateway fleet serves exactly one `isolation_cell_id`.

Pros:

- smallest blast radius
- easiest mental model
- matches current OpenClaw guidance for strong separation
- ingress policy is simple

Cons:

- more gateway fleets
- cross-cell orchestration needs explicit re-issue path
- more operational overhead

Default recommendation for first Superclaw DC version.

### Shape B: Cell-Aware Routed Gateway Fleet

Gateway fleet serves multiple `isolation_cell_id` values but routes by signed ingress proof and routing table.

Pros:

- lower gateway fleet count
- easier shared global ingress
- can centralize rate limiting

Cons:

- gateway becomes stronger trust boundary
- route-table bugs can become cross-cell bugs
- requires stronger formal admission tests

Allowed later only if contract tests prove route isolation.

## Request Context Creation

Context is created by gateway only.

Input sources:

- trusted gateway operator identity;
- signed L5 `AliasAssertion`;
- internal service identity with workload SVID;
- resume token tied to previous context and live capability.

Rejected sources:

- raw channel sender ID;
- channel allowlist entry;
- untrusted HTTP header;
- runtime-provided `tenant_id`;
- caller-provided metadata inside tool params.

Flow:

```text
inbound event
  -> adapter normalizes platform facts
  -> adapter produces AliasAssertion or runs inside gateway boundary
  -> gateway verifies proof and routing table
  -> gateway builds SuperclawRequestContext
  -> capability issuer mints root capability
  -> PDP pre-dispatch
  -> placement/runtime admission
```

## Storage Mapping

Every durable org/data record gets these columns or equivalent partition keys:

```text
customer_tenant_id
org_id
isolation_cell_id
data_residency_region
erasure_epoch
classification_epoch
created_by_principal_id
created_by_capability_hash
```

Memory records additionally carry:

```text
memory_record_id
memory_scope
provenance_graph_id
write_intent_id
state: pending | active | blocked | erasing | erased | poison
```

Read path must check storage keys, not just application metadata.

## KMS / Crypto-Erasure Mapping

Minimum key hierarchy:

```text
root/customer_tenant_id
  -> org_id
    -> isolation_cell_id
      -> data_class
        -> object_key
```

Crypto-erasure by leaver/org/data class uses key revocation when the data class requires hard purge guarantees. Delete-by-entity is allowed only for low-risk classes where policy accepts eventual physical deletion.

The receipt must record:

- affected key scope;
- erasure epoch;
- object IDs or graph query digest;
- actor principal;
- policy decision ID;
- signed deletion/crypto-shred event.

## Runtime Admission Checks

Runtime admission sidecar checks:

```text
workload_svid.trust_domain == context.spiffe_trust_domain
workload_svid.san maps to runtime_id
runtime_id belongs to context.runtime_pool_id
runtime_pool_id belongs to context.namespace_id
namespace_id belongs to context.isolation_cell_id
runtime_class satisfies effective_data_classes
resume checkpoint context hash matches current context
root/child capability hash matches context
```

Fail closed:

- wrong cell;
- wrong namespace;
- wrong runtime pool;
- expired/missing SVID;
- runtimeClass downgrade;
- checkpoint from another context;
- missing capability.

## Placement Inputs

Placement must receive:

```yaml
customer_tenant_id:
org_id:
isolation_cell_id:
namespace_id:
runtime_pool_id:
data_residency_region:
effective_data_classes:
required_runtime_class:
required_attestation_profile:
latency_slo:
quota_bucket:
```

Placement may not infer customer/org/cell from a tool request body.

## MSP / Cross-Customer Case

Cross-customer delegation is not "same token, broader scope".

Required pattern:

1. Principal has MSP admin relationship in policy.
2. Gateway receives request for target customer/org/cell.
3. PDP authorizes cross-customer action.
4. Capability issuer mints a new root capability for target boundary.
5. Receipt links source and target action IDs.

Denied pattern:

- parent token from customer A directly attenuates into customer B.

## Acceptance Gates

RFC-01 is acceptable when these tests exist and pass:

1. Unsigned channel inbound cannot create context.
2. Signed alias for cell A cannot route to cell B.
3. Runtime in namespace A cannot resume checkpoint from namespace B.
4. Runtime pool mismatch fails before agent execution.
5. Parent capability from customer A cannot attenuate into customer B.
6. Storage read with matching `org_id` but wrong `isolation_cell_id` is denied.
7. PDP outage fails closed for material actions.
8. Erasure event increments `erasure_epoch` and invalidates stale reads.

## Open Questions

1. First deployment should use gateway-per-cell unless platform ops cost forces routed fleet.
2. Need exact source of truth for routing table: L6 org plane DB, gateway config, or signed cell registry.
3. Need exact KMS provider and key rotation cadence.
4. Need migration path for any existing `tenant_id` fields in prototype code.
