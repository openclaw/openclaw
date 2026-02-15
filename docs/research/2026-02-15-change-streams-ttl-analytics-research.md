# Research: Change Streams, TTL Indexes, and Aggregation Analytics

**Date:** 2026-02-15
**Context:** ClawMongo-v2 MongoDB memory backend — planning new features

## Change Streams

### Availability

- **MongoDB Community Edition: YES** — Change Streams are available
- **Requirement: Replica Set** — Change Streams require oplog, so standalone deployments are NOT supported
- **Our setup:** Already uses replica set (both Docker dev and production) — compatible

### How Change Streams Work

- `collection.watch()` opens a persistent cursor on the oplog
- Events: `insert`, `update`, `replace`, `delete`, `invalidate`
- `resumeToken` allows reconnection after disconnects without missing events
- Can watch: single collection, database, or entire deployment
- Pipeline support: can filter events server-side (e.g., only watch `source: "memory"`)

### Implementation Pattern (from powersync-service)

- Use `ChangeStreamOptions` with `abort_signal` for graceful shutdown
- Track `resumeToken` for resume after disconnect
- Handle `invalidate` events by restarting the stream
- Use `maxAwaitTimeMS` to avoid blocking indefinitely

### Application to ClawMongo

- Watch `files` and `chunks` collections for cross-instance sync
- When Instance A syncs new memory files, Instance B gets notified immediately
- Resume tokens should be persisted in `meta` collection
- Graceful degradation: if standalone (no replica set), fall back to polling

### Key Considerations

- Change Streams are relatively lightweight (uses oplog tailing)
- Need error handling for: network disconnects, invalidation, topology changes
- Should be opt-in (new config option: `memory.mongodb.enableChangeStreams: true`)

## TTL Indexes

### Availability

- **All MongoDB editions** — TTL indexes are a core feature since MongoDB 2.2
- **No replica set requirement** — works on standalone too

### How TTL Indexes Work

- `createIndex({ fieldName: 1 }, { expireAfterSeconds: N })`
- MongoDB background thread checks every 60 seconds and deletes expired documents
- The indexed field MUST be a Date type
- Only works on single-field indexes

### Application to ClawMongo

- `embedding_cache` collection: TTL to auto-expire stale cached embeddings
  - Field: `cachedAt` (already exists or can be added)
  - Default TTL: 30 days (configurable via `memory.mongodb.embeddingCacheTtlDays`)
- `files` collection: Could add TTL for auto-cleanup of very old memories
  - More dangerous — would need user awareness
  - Better as opt-in: `memory.mongodb.memoryTtlDays` (default: disabled)

### Key Considerations

- TTL deletion is not immediate (60-second polling interval)
- Cannot use TTL on `_id` field
- TTL index can coexist with other indexes on the same field
- Deletion is not transactional — documents disappear one by one

## Aggregation Analytics

### Availability

- **All MongoDB editions** — aggregation pipeline is core feature

### Application to ClawMongo

- `openclaw memory stats` command using aggregation pipeline:
  - File count by source (memory vs sessions)
  - Chunk count and average chunks per file
  - Stale file detection (files in DB not on disk)
  - Embedding coverage (files with embeddings vs without)
  - Collection sizes and index sizes
  - Search capability summary

### Pipeline Examples

```javascript
// Per-source breakdown
db.files.aggregate([
  { $group: { _id: "$source", count: { $sum: 1 }, lastSync: { $max: "$syncedAt" } } },
]);

// Embedding coverage
db.chunks.aggregate([
  {
    $group: {
      _id: "$path",
      hasEmbedding: {
        $max: { $cond: [{ $gt: [{ $size: { $ifNull: ["$embedding", []] } }, 0] }, true, false] },
      },
    },
  },
  { $group: { _id: "$hasEmbedding", count: { $sum: 1 } } },
]);
```

## Remaining Audit Fixes (from pre-fix audit)

### Already Fixed by Transaction Work

- [HIGH] Session files don't use transactions — FIXED
- [MEDIUM] Stale deletion outside transaction — FIXED
- 3 test failures (toSorted) — FIXED

### Still Relevant

1. **[MEDIUM] Hardcoded numDimensions:1536** — in mongodb-schema.ts vector index definition
   - Should be configurable or auto-detected from embedding provider
   - Voyage-4-large uses 1024 dimensions, not 1536
   - Other providers have different dimensions

2. **[MEDIUM] \_id type casting fragile** — `as unknown as ObjectId` pattern
   - Our \_id is a string (path-based), not ObjectId
   - The casting works but is fragile — should use proper typing

3. **[LOW] embedding_cache no TTL** — stale embeddings accumulate forever
   - See TTL Indexes section above

4. **[LOW] No schema validation** — documents can have wrong shape
   - MongoDB JSON Schema validation can enforce document structure
   - Should be optional/additive

5. **[LOW] automatedEmbedding capability detection imprecise**
   - Currently checks version string; should try creating a test index

6. **[LOW] No maxPoolSize config** — MongoClient uses default pool size
   - Add `memory.mongodb.maxPoolSize` config option
