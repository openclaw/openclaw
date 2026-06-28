# RFC-03: Capability, PDP, and ActionReceipt Contract

Status: draft

Date: 2026-06-27

Depends on:

- `rfc-00-control-spine.md`
- `rfc-01-tenant-isolation.md`
- `rfc-02-gateway-l5-identity.md`

## Summary

Superclaw DC needs one authorization chain:

```text
verified identity -> request context -> root capability -> PDP decision -> material action -> ActionReceipt
```

This RFC defines the implementation contract for root capability minting, attenuation, PDP cache safety, and tamper-evident action receipts.

## Root Capability Mint

Root capability is minted after gateway context creation and before L4 dispatch.

Issuer:

```text
superclaw-capability-issuer
```

Inputs:

```yaml
request_id:
trace_id:
canonical_principal_id:
org_id:
customer_tenant_id:
isolation_cell_id:
namespace_id:
runtime_pool_id:
data_residency_region:
alias_binding_event_id:
alias_binding_epoch:
policy_epoch:
classification_epoch:
requested_agent_id:
requested_action:
effective_data_classes:
expires_at:
```

Output:

```yaml
capability_id:
capability_hash:
issuer:
subject_principal_id:
audience: l4-dispatch
org_id:
customer_tenant_id:
isolation_cell_id:
namespace_id:
runtime_pool_id:
allowed_actions:
allowed_tools:
allowed_data_classes:
memory_scopes:
channel_scopes:
budget_scope:
expires_at:
parent_capability_hash: null
max_hops:
revocation_epoch:
signature:
```

Root capability is not caller-provided. Gateway stores only hash/handle in traces where possible.

## Attenuation

L4 may attenuate for sub-agent dispatch.

Rules:

```text
child.org_id == parent.org_id
child.customer_tenant_id == parent.customer_tenant_id
child.isolation_cell_id == parent.isolation_cell_id
child.namespace_id == parent.namespace_id unless policy grants namespace-local delegation
child.allowed_actions subset parent.allowed_actions
child.allowed_tools subset parent.allowed_tools
child.allowed_data_classes no less restrictive than parent.allowed_data_classes
child.expires_at <= parent.expires_at
child.max_hops < parent.max_hops
parent not revoked
```

Cross-customer or cross-cell delegation requires new root mint, not attenuation.

## PDP Request

`PolicyDecisionRequest`:

```yaml
schema: superclaw.policy_decision_request.v0
decision_id:
trace_id:
request_id:
action_id:
principal:
  canonical_principal_id:
  principal_type:
identity:
  org_id:
  customer_tenant_id:
  isolation_cell_id:
  alias_binding_event_id:
  alias_binding_epoch:
runtime:
  workload_svid_hash:
  runtime_id:
  namespace_id:
  runtime_pool_id:
capability:
  capability_hash:
  parent_capability_hash:
  max_hops_remaining:
resource:
  kind:
  id:
  owner_org_id:
  data_classes:
action:
  verb:
  tool_identity:
  skill_manifest_id:
  mcp_server_id:
context:
  policy_epoch:
  revocation_epoch:
  classification_epoch:
  erasure_epoch:
  relationship_snapshot_id:
```

## PDP Response

```yaml
schema: superclaw.policy_decision_response.v0
decision_id:
effect: allow | deny
reason_code:
policy_bundle_id:
policy_epoch:
routine_or_invariant: routine | invariant
cache:
  cacheable: true | false
  ttl_ms:
  invalidation_epochs:
    policy_epoch:
    alias_binding_epoch:
    revocation_epoch:
    classification_epoch:
    erasure_epoch:
obligations:
  redaction_profile:
  receipt_required: true
  action_receipt_visibility: user | org-admin | security-only
  max_runtime_class:
  required_attestation_profile:
  memory_write_mode:
signature:
```

## Cache Key

Allow-decision cache key:

```text
principal_id
org_id
customer_tenant_id
isolation_cell_id
action_verb
resource_kind
resource_id
tool_identity
skill_manifest_id
effective_data_classes
capability_hash
policy_epoch
alias_binding_epoch
revocation_epoch
classification_epoch
erasure_epoch
relationship_snapshot_id
```

Fail modes:

- PDP missing: fail closed for material actions.
- stale epoch: cached allow invalid.
- missing receipt obligation: fail closed after action proposal, before side effect.
- deny cache may be short-lived; allow cache must be bounded and epoch-checked.

## ActionReceipt

`ActionReceipt` is the audit/security receipt. It is not the channel `MessageReceipt`.

```yaml
schema: superclaw.action_receipt.v0
receipt_id:
action_id:
trace_id:
request_id:
created_at:
principal_id:
org_id:
customer_tenant_id:
isolation_cell_id:
namespace_id:
runtime_pool_id:
capability_hash:
policy_decision_id:
policy_effect:
effective_data_classes:
resource_refs:
memory_read_set:
memory_write_set:
tool_identity:
skill_manifest_id:
channel:
  channel_id:
  engagement_id:
  alias_binding_event_id:
platform_receipt_ref:
redaction_profile:
prev_receipt_hash:
receipt_hash:
signed_by:
signature:
```

Receipt hash covers the canonical payload excluding signature.

## Material Action State Machine

```text
proposed
  -> policy_pending
  -> authorized | denied
  -> side_effect_pending
  -> side_effect_applied | side_effect_failed
  -> receipt_committed | receipt_failed
```

Success means:

```text
side_effect_applied && receipt_committed
```

Platform delivery without `receipt_committed` is incomplete, not success.

## Tests

Required:

1. root capability cannot be caller-provided.
2. child capability cannot exceed parent scope.
3. child capability cannot outlive parent.
4. revoked parent invalidates resume/delegation.
5. cached allow invalidates on revocation epoch.
6. cached allow invalidates on classification epoch.
7. side effect denied when PDP unavailable.
8. platform receipt without ActionReceipt is incomplete.
9. receipt hash changes if policy decision ID changes.
10. receipt signature issuer must match isolation cell trust domain.

## Open Questions

1. Biscuit vs macaroon vs JWT/COSE for first implementation.
2. Where revocation epoch lives: capability service, PDP, or shared security-plane registry.
3. Whether receipt chain is per org, per principal, per action stream, or per isolation cell.
4. Whether invariant tier always signs decisions separately from routine tier.
