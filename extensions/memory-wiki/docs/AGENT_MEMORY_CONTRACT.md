# Agent Memory Contract

The memory wiki is a compiled, freshness-gated cache over canonical durable memory files. It is not the source of truth.

Agents must follow this contract on every task that can depend on durable project or operator memory:

1. Check wiki injection status with `wiki.status` before doing task work. `wiki.status` is pure read and must not sync, refresh, compile, or mutate cache artifacts.
2. If the wiki is injectable, load `.openclaw-wiki/cache/agent-digest.json` and the relevant claim rows from `.openclaw-wiki/cache/claims.jsonl` before making memory-dependent decisions.
3. If the wiki is not injectable because the cache is stale, missing, or otherwise rejected, fall back to reading canonical memory files directly.
4. Record a memory utilization receipt with `wiki.record_receipt` at the end of the run. The receipt must cite the claim IDs or memory paths used.
5. If changing durable truth, write back to the canonical memory files. Do not write durable truth only to wiki cache files or generated source pages.
6. Never treat wiki source pages as canonical when durable memory files conflict. Canonical durable memory wins over compiled wiki pages, digests, and claim rows.

## Receipt Shape

Receipts are written as NDJSON under `.openclaw-wiki/telemetry/memory-receipts.jsonl` and must match `schemas/memory-utilization-receipt.schema.json`.

Required fields:

- `run_id`: stable run or session identifier.
- `task`: concise task description.
- `memory_preflight.performed`: whether memory preflight happened.
- `memory_preflight.wiki_injectable`: whether the compiled wiki cache was usable.
- `memory_preflight.reason_if_not`: nullable reason when the wiki was not injectable.
- `memory_preflight.files_read`: canonical memory or cache paths read.
- `memory_preflight.claims_used`: claim IDs used for decisions.
- `decisions_influenced_by_memory`: decisions that changed because memory was read.
- `writeback.performed`: whether durable truth was updated.
- `writeback.paths`: canonical memory paths updated.

Generated receipts are audit telemetry. They do not replace memory writeback.
