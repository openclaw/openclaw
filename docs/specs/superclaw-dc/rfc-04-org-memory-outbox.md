# RFC-04: Org Memory Outbox and Provenance Contract

Status: draft

Date: 2026-06-27

Depends on:

- `rfc-00-control-spine.md`
- `rfc-01-tenant-isolation.md`
- `rfc-03-capability-pdp-receipt.md`

## Summary

Mem0 metadata is not the hard enforcement boundary. Superclaw DC needs an org-memory lifecycle service that owns write intent, provenance graph, erasure state, promotion state, and read enforcement.

Default implementation model: recoverable outbox. Do not require distributed transactions across Mem0 and graph storage.

## Components

### OrgMemoryLifecycleService

Authoritative service for:

- memory object state;
- write intents;
- provenance/dependency edges;
- promotion records;
- erasure epochs;
- read authorization projection;
- receipt linkage.

### Mem0Adapter

Adapter/index layer for:

- vector/search write;
- recall query;
- external memory backend ID mapping;
- backend health.

Mem0Adapter never decides tenant/org/cell access by itself.

### Reconciler

Repairs partial states:

- intent created, Mem0 write missing;
- Mem0 write applied, graph edge missing;
- graph edge applied, receipt missing;
- erasure started, backend delete/shred incomplete.

## Memory Object

```yaml
memory_record_id:
external_memory_id:
org_id:
customer_tenant_id:
isolation_cell_id:
data_residency_region:
memory_scope:
data_class:
state: pending | active | blocked | erasing | erased | poison
write_intent_id:
provenance_graph_id:
created_by_principal_id:
created_by_capability_hash:
policy_decision_id:
action_receipt_id:
classification_epoch:
erasure_epoch:
created_at:
updated_at:
```

## Write Intent State Machine

```text
intent_created
  -> pdp_authorized
  -> mem0_write_pending
  -> mem0_write_applied
  -> graph_edges_pending
  -> graph_edges_applied
  -> receipt_pending
  -> committed
```

Failure states:

```text
blocked
poison
erasing
erased
```

Read exposure:

- only `committed` memory records become `active`;
- `blocked`, `pending`, `poison`, `erasing`, `erased` are not returned to agent recall.

## Write Transaction

Single local transaction in org-memory DB:

```text
create write_intent
record policy_decision_id
record requested data_class/memory_scope
record context hash
enqueue mem0_write job
```

External side effects:

```text
worker writes Mem0
worker records external_memory_id
worker writes provenance graph edges
worker commits ActionReceipt
worker marks memory active
```

If a worker dies, reconciler resumes from durable intent state.

## Read Invariant

A memory record is readable only when:

```text
state == active
org_id == context.org_id
customer_tenant_id == context.customer_tenant_id
isolation_cell_id == context.isolation_cell_id OR explicit replication grant exists
data_class allowed by PDP response
provenance graph state == applied
erasure_epoch <= reader_erasure_epoch
classification_epoch <= reader_classification_epoch
```

Mem0 search results are candidates only. OrgMemoryLifecycleService filters and authorizes before returning content.

## Erasure

Erasure request flow:

```text
erase_intent_created
  -> policy_authorized
  -> records_marked_erasing
  -> backend_delete_or_crypto_shred
  -> graph_edges_tombstoned
  -> erasure_receipt_committed
  -> records_marked_erased
```

Read behavior:

- `erasing` blocks reads immediately.
- stale cached recalls with older `erasure_epoch` are invalid.
- if backend delete fails, state remains `erasing` or `poison`, not `active`.

## Promotion

Promotion records are first-class objects:

```yaml
promotion_event_id:
object_kind: memory | skill | mcp | policy
source_object_id:
target_scope: user | team | org
approver_principal_ids:
policy_decision_id:
action_receipt_id:
predicate_hash:
signed_by:
state: proposed | approved | applied | rejected | revoked
```

Promotion writes must use the same outbox/receipt model.

## Tests

Required:

1. Mem0 write success + graph failure blocks read.
2. Graph success + receipt failure blocks read.
3. Wrong `isolation_cell_id` blocks read even when `org_id` matches.
4. Reconciler completes stuck `mem0_write_applied` intent.
5. Erasure marks record unreadable before backend delete completes.
6. Stale recall cache invalidates on `erasure_epoch`.
7. Promotion event cannot apply without approver policy decision.
8. Poison record appears in admin audit, not agent recall.

## Open Questions

1. Is org-memory DB Postgres, FoundationDB, or another transactional store?
2. Is Mem0 a mandatory backend or one adapter among several recall backends?
3. How are provenance graph queries indexed for read-time enforcement latency?
4. Which data classes require crypto-shred instead of delete-by-entity?
