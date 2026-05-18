# Qdrant Workspace Reconciliation — Post-Implementation Bug Report

**Date:** 2026-05-17 (evening, UTC)
**Author:** Claude (Opus 4.7) during live preliminary agent testing of the Qdrant + MCP integration
**Related plan:** `docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md`
**Trigger:** OpenClaw agent reported `Error calling tool 'qdrant-find': 'document'` after the workspace-reconciler rollout

This document tracks the **1 open issue** still worth keeping on the board after Sprint 3. Nine earlier issues are now worked off: the two initial P1 bugs, the three Sprint 1 cleanup items, the three Sprint 2 reconciler hardening items, and the Sprint 3 session-corpus invariant test. See Appendix B for the fix record.

Severity legend:

- **P1** — blocks user-visible feature, must fix
- **P2** — degrades reliability or developer workflow, should fix soon
- **P3** — latent risk or hygiene; pick up when in the area

---

## Status Index

| #   | Title                                                                 | Severity           |
| --- | --------------------------------------------------------------------- | ------------------ |
| 1   | `indexed_vectors_count` is 0 because HNSW indexing threshold is 20000 | Informational / P3 |

---

## 1. `indexed_vectors_count: 0` because HNSW threshold is 20000

### Observation

```
$ curl -s http://127.0.0.1:6333/collections/agent-memory | jq .result
{
  "points_count": 901,
  "indexed_vectors_count": 0,
  "config.optimizer_config.indexing_threshold": 20000
}
```

All 901 points are searched by brute-force scan, not via HNSW. Per-query latency is still ~5-15 ms in testing, but this scales linearly with collection size.

### Action

Not a bug today. Re-evaluate when point count crosses ~5 000-10 000 or query latency exceeds a budget. The Qdrant default of 20 000 is suitable for static collections; for incrementally-grown collections, lower it to 1 000-5 000 to start building the index sooner. To change:

Resolution: defer (revisit at 5k points).

```yaml
# When (re-)creating the collection
optimizer_config:
  indexing_threshold: 2000
```

## Appendix A — Diagnosis recipes useful for the open items

1. **Live state inspection of the `agent-memory` collection:**

   ```bash
   curl -s http://127.0.0.1:6333/collections/agent-memory | jq .result
   curl -s -X POST http://127.0.0.1:6333/collections/agent-memory/points/scroll \
     -H 'Content-Type: application/json' \
     -d '{"limit":1000,"with_payload":true,"with_vector":false}' | jq
   ```

   Use this to audit the collection when the deferred issue #1 comes back into scope.

2. **Undici tracing for reconciler HTTP behavior:**

   ```bash
   docker exec -u node openclaw-openclaw-gateway-1 sh -c \
     'NODE_DEBUG=undici openclaw qdrant workspace reconcile --apply --json > /tmp/recon.out 2>/tmp/recon.err'
   ```

   Useful if future large-workspace regressions reintroduce slow reconcile or socket-lifecycle failures.

## Appendix B — Already-fixed bugs from the same session (for cross-reference)

The initial P1 bugs, Sprint 1 cleanup items, Sprint 2 reconciler hardening work, and Sprint 3 session-corpus invariant test are recorded in:

- `docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md` § _Post-Rollout Corrections_
- Commit `be224c265c` — `fix(memory): add document payload key and retry EPIPE in qdrant reconciler`
- Commit `e27ac4cab7` — `docs: qdrant post-implementation bug report and plan corrections`
- Commit `65bc177037` — `fix(build): preserve dist bind mounts and add deploy wrapper`
- Commit `17ec1927de` — `fix(memory): harden qdrant workspace reconcile updates`
- Commit `b49c190d28` — `test(memory): pin workspace reconcile session exclusion`
- Host stack change on 2026-05-18 — upgraded `/home/ubuntu/.qdrant/docker-compose.yml` from `qdrant/qdrant:v1.12.4` to `qdrant/qdrant:v1.18.0` via consecutive minor hops after taking a volume snapshot and re-verifying `qdrant-find`
- Local environment repair on 2026-05-18 — `pnpm install` restored the already-declared `web-tree-sitter@0.26.8`, after which `pnpm build:plugin-sdk:dts` passed cleanly with no manifest delta

Files touched by those fixes:

```
packages/memory-host-sdk/src/host/workspace-reconcile.ts
packages/memory-host-sdk/src/host/workspace-reconcile.test.ts
src/commands/qdrant-workspace-reconcile.ts
src/commands/qdrant-workspace-reconcile.test.ts
docs/superpowers/plans/2026-05-17-qdrant-workspace-reconciliation.md
docs/superpowers/plans/2026-05-17-qdrant-post-implementation-bug-report.md (this file)
```
