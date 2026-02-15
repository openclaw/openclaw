# Discussion #16586 — Update Comment

> Post this as a comment on https://github.com/openclaw/openclaw/discussions/16586

---

## Progress update — ACID transactions, TTL auto-cleanup, analytics, change streams

Since the initial proposal, the implementation has grown significantly. Here's what's new and why it matters for production deployments.

### ACID transactions for multi-write consistency

This directly addresses **#10324** (still open — multi-write operations lack transaction wrappers).

The MongoDB backend wraps all multi-document writes in `withTransaction()`:

- **File sync** — chunking + metadata update as one atomic operation
- **Session sync** — same atomic guarantee for conversation transcripts
- **Stale cleanup** — batch `deleteMany` with `$in` inside a transaction

Graceful degradation: on standalone MongoDB (no replica set), transactions are auto-detected as unavailable and skipped — sync still works, just without atomicity. No config needed, no crashes.

```typescript
// What actually happens inside syncToMongoDB:
await client.withTransaction(async (session) => {
  await deleteChunksForPath(chunks, path, session);
  await upsertChunks(chunks, path, source, chunkList, model, embeddings, session);
  await upsertFileMetadata(files, entry, source, session);
});
// If ANY operation fails, ALL are rolled back. Zero partial state.
```

### TTL auto-cleanup — no cron jobs needed

Two new config options that leverage MongoDB's native TTL indexes:

| Config                  | Default        | What it does                                                |
| ----------------------- | -------------- | ----------------------------------------------------------- |
| `embeddingCacheTtlDays` | `30`           | Auto-expires stale embedding cache entries                  |
| `memoryTtlDays`         | `0` (disabled) | Auto-expires old memory files (opt-in, logged with WARNING) |

MongoDB handles the cleanup in the background — no application-level cron, no manual purge scripts. This is particularly useful for long-running deployments where embedding caches grow unbounded.

### Analytics — `memory stats` for operators

New `getMemoryStats()` method provides a production dashboard:

- **Per-source breakdown** — memory files vs session transcripts: file counts, chunk counts, last sync timestamp
- **Embedding coverage** — how many chunks have embeddings vs how many don't (catches silent embedding failures)
- **Collection sizes** — document counts across all 4 collections
- **Stale detection** — files in MongoDB that no longer exist on disk

This gives operators visibility into memory health that doesn't exist today with any backend.

### Change Streams — real-time cross-instance sync (opt-in)

When multiple OpenClaw instances share one MongoDB:

```yaml
memory:
  mongodb:
    enableChangeStreams: true # default: false
```

Instance A writes a memory file → Instance B detects it via MongoDB Change Stream → B marks itself dirty and syncs on next search. No polling intervals, no stale reads between instances.

Requires replica set (same as transactions). Gracefully disabled on standalone with a log message.

---

### Updated test coverage

| Metric     | Initial proposal | Now     |
| ---------- | ---------------- | ------- |
| Unit tests | 184              | **221** |
| E2E tests  | 21               | **35**  |
| Total      | 205              | **256** |
| TSC errors | 0                | 0       |

The E2E tests run against a **real MongoDB 8.2 Community** instance (Docker, single-node replica set) — not mocks. They test actual index creation, sync workflows, `$text` search, transactions, TTL behavior, analytics aggregation, and change stream event delivery.

### Updated issue resolution

| Issue          | Status                  | How                                                                                |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| **#10324**     | **Solved**              | `withTransaction()` wraps all multi-document writes. Graceful standalone fallback. |
| #11480, #14716 | Solved                  | Server-based — no file locks, no bind-mount issues                                 |
| #9888          | Solved                  | Data persists in MongoDB, survives container restarts                              |
| #11565         | Solved                  | No local file dependency for persistence                                           |
| #13440         | Solved                  | Multiple gateways share one database natively                                      |
| #11721, #16164 | Solved (automated mode) | Server-side Voyage AI embeddings — no local model, no fd leaks                     |

I acknowledge that **#11308 was closed** — the QMD team has made real progress fixing individual sub-issues. The MongoDB backend isn't positioned as a QMD replacement. It's a **different architecture for a different deployment model**: teams running OpenClaw in production with multiple instances, containers, or managed infrastructure where a server-based database is the natural fit.

### What this enables that file-based backends can't

These aren't criticisms of SQLite or QMD — they're architectural limitations of file-based storage:

1. **Multi-instance memory sharing** — N gateways, one truth. No file sync, no conflict resolution.
2. **Zero-downtime deployments** — Roll new instances, old ones drain. Database doesn't care.
3. **Native ACID** — Crash mid-sync? Transaction rolls back. No orphaned chunks.
4. **Operational visibility** — Analytics, TTL, change streams are database-native. No bolted-on scripts.
5. **Scaling path** — Start with Community free tier, scale to Atlas sharded cluster. Same code.

### Minimal footprint reminder

Only **6 existing files touched** (all additive — zero changes to builtin/QMD code paths):

- `types.memory.ts`, `types.ts`, `backend-config.ts`, `search-manager.ts` — config + factory wiring
- `configure.shared.ts`, `configure.wizard.ts` — DX wizard integration

**11 new source files** (all under `src/memory/mongodb-*` or `src/wizard/onboarding-memory*` or `src/commands/configure-memory*`). The `mongodb` driver remains a lazy dynamic import — zero cost for users who don't use it.

Default backend remains **`"builtin"`**. MongoDB is strictly opt-in.

### What I'm asking

1. **Is this the right direction?** The PostgreSQL proposal (#15093) and the community member who built their own MCP facade both point to demand for database-backed memory. MongoDB and PostgreSQL aren't mutually exclusive — both solve the core problem of giving production teams a server-based alternative.

2. **Ready for PR review?** The implementation is complete, tested (256 tests), and follows the existing codebase patterns. I can split into focused PRs per CONTRIBUTING.md guidance.

3. **Any architectural concerns?** Happy to iterate on the approach, config structure, or search cascade design.

Fork with full implementation: https://github.com/romiluz13/ClawMongo/tree/feat/mongodb-memory-backend
