# Superclaw DC Contract Experiments

Date: 2026-06-27

Scope: executable contract spike for RFC-01/RFC-00 blockers.

Experiment file:

- `reports/superclaw-dc/experiments/contract-negative-tests.mjs`
- `reports/superclaw-dc/experiments/schema-validation.mjs`

Schema files:

- `reports/superclaw-dc/contracts/v0/request-context.schema.json`
- `reports/superclaw-dc/contracts/v0/alias-assertion.schema.json`
- `reports/superclaw-dc/contracts/v0/capability.schema.json`
- `reports/superclaw-dc/contracts/v0/policy-decision-response.schema.json`
- `reports/superclaw-dc/contracts/v0/action-receipt.schema.json`
- `reports/superclaw-dc/contracts/v0/memory-write-intent.schema.json`

Run:

```bash
node reports/superclaw-dc/experiments/contract-negative-tests.mjs
node reports/superclaw-dc/experiments/schema-validation.mjs
```

Expected:

```text
contract-negative-tests: 14 checks passed
schema-validation: 8 checks passed
```

## What This Proves

The experiment is deliberately small. It is not production implementation. It proves that the clarified contracts can be turned into deterministic fail-closed checks.

Covered checks:

1. Unsigned alias assertion cannot create context.
2. Gateway rejects an isolation cell it does not serve.
3. Namespace mismatch fails before context reaches runtime.
4. Runtime pool mismatch fails before context reaches runtime.
5. Child capability cannot request a scope the parent does not have.
6. Child capability cannot cross customer tenant.
7. Child capability cannot outlive parent.
8. Cached allow decision invalidates on `revocation_epoch`.
9. Memory record with missing provenance edge is blocked even when Mem0-like write exists.
10. Platform delivery receipt without `ActionReceipt` is not audited material action success.
11. Resume checkpoint with old context hash is rejected.
12. Resume checkpoint with revoked capability is rejected.
13. Erasure event marks matching memory record.
14. Memory record in `erasing` state blocks read.
15. Valid v0 schemas accept canonical examples.
16. Request context with old `tenant_id` fails because `customer_tenant_id` is missing and `tenant_id` is additional.

## Implementation Lessons

### Tenant/Isolation

The routing table must be explicit and gateway-local or gateway-verifiable. The contract harness makes `isolation_cell_id`, `namespace_id`, and `runtime_pool_id` separate checks because a single `tenant_id` cannot catch wrong-cell and wrong-pool bugs.

### L5/Gateway Boundary

The adapter can normalize channel events, but context creation starts only after signed alias assertion verification. This keeps raw channel IDs out of canonical principal authority.

### Capability Lifecycle

Root capability belongs before L4 dispatch. L4 attenuation is a subset operation over an existing parent. Cross-customer dispatch requires a new root token, not a child token.

### PDP Cache

Allow-cache validity depends on epochs. TTL alone is not enough. Revocation, alias-binding changes, policy changes, and classification changes invalidate stale allow decisions.

### Org Memory

The experiment models Mem0 write and provenance graph state separately. Reads are blocked unless provenance is applied. That points to an outbox/reconciler design rather than pretending Mem0 and graph writes are one atomic operation.

### Receipts

`MessageReceipt` and `ActionReceipt` must be separate. Platform delivery can succeed while audit/security receipt is missing; that state must be visible as incomplete, not success.

## Next Contracts To Add

1. Resume checkpoint rejects old context hash.
2. Alias binding `superseded` event invalidates old assertion.
3. PDP outage fail-closed for side-effectful tool call.
4. Erasure epoch invalidates memory reads and cached policy decisions.
5. Cross-cell MSP action mints a new root capability and linked receipt pair.
