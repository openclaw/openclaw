# Agent Memory Contract

The memory wiki is a compiled, freshness-gated cache over canonical durable memory files. It is not the source of truth.

Agents must follow this contract on every task that can depend on durable project or operator memory:

1. Check wiki injection status with `wiki.status` or the model-facing `wiki_status` tool before doing task work. Status checks are pure read and must not sync, refresh, compile, or mutate cache artifacts. Treat `injection.injectable` as the cache-use decision. Call `wiki.refresh`, `wiki refresh`, or the model-facing `wiki_refresh` tool first only when you intentionally need the old status-heartbeat behavior that imports bridge or unsafe-local sources and rebuilds the compiled cache.
2. If the wiki is injectable, load `.openclaw-wiki/cache/agent-digest.json` and the relevant claim rows from `.openclaw-wiki/cache/claims.jsonl` before making memory-dependent decisions.
3. If the wiki is not injectable because the cache is stale, missing, or otherwise rejected, fall back to reading canonical memory files directly.
4. Record a memory utilization receipt with `wiki.record_receipt` or the model-facing `wiki_record_receipt` tool at the end of the run. The receipt must cite the claim IDs or memory paths used.
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

## Status Refresh Migration

Before this contract, some callers used `wiki.status` or `wiki_status` as a heartbeat that both synced imported sources and reported cache state. That mixed read/write behavior is retired.

Use this replacement map:

- Read-only health or injection check: call `wiki.status` or `wiki_status`.
- Imported-source sync plus cache rebuild: call gateway `wiki.refresh`, CLI `wiki refresh`, or model tool `wiki_refresh`.
- Existing automation that previously called status to keep bridge or unsafe-local cache warm must call refresh first, then status.

This is an intentional compatibility boundary. Status purity prevents passive diagnostics from mutating `agent-digest.json`, `claims.jsonl`, or `wiki-cache-manifest.json`; refresh owns those writes.
