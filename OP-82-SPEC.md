# OP-82: Temporal Edge Support in Neo4j Memory Graph

## OpenSpec v1.0

**Author:** Ada (AI) + Tarun Sukhani
**Created:** 2026-03-03
**Priority:** High
**Module:** `extensions/memory-neo4j`
**Branch:** `op-82-temporal-edges`
**Base:** `adabot` branch

---

## 1. Problem Statement

OpenClaw's memory system treats all stored memories as eternally valid. When a user's preference changes (e.g., "I prefer dark mode" → "I switched to light mode"), both memories coexist with equal validity. The `memory_recall` tool returns both, forcing the LLM to guess which is current. On the LoCoMo benchmark, this temporal confusion is the #1 failure mode — humans score 92.6 F₁ on temporal questions vs. GPT-4 at 20-30 F₁.

### Current Behavior

- `memory_store("I prefer dark mode")` → stored with `createdAt` timestamp
- Later: `memory_store("I switched to light mode")` → stored separately
- `memory_recall("theme preference")` → returns BOTH memories, no temporal ordering or invalidation
- LLM must infer recency from `createdAt` — unreliable, especially after merges

### Desired Behavior

- New memory that contradicts an existing one automatically marks the old one as superseded
- `memory_recall` returns only currently-valid memories by default
- Historical queries ("What did Tarun prefer before?") remain possible
- The sleep cycle leverages temporal metadata for smarter cleanup

---

## 2. Design

### 2.1 Schema Changes (MemoryNode)

Add three new fields to the `MemoryNode` type in `schema.ts`:

```typescript
export type MemoryNode = {
  // ... existing fields ...

  // Temporal validity (bi-temporal)
  validFrom: string; // ISO-8601 — when this fact became true (defaults to createdAt)
  validUntil?: string; // ISO-8601 — when this fact stopped being true (null = still valid)
  supersededBy?: string; // ID of the memory that replaced this one (null = not superseded)
};
```

**Rules:**

- `validFrom` defaults to `createdAt` at store time
- `validUntil` is `null` for currently-valid memories
- `supersededBy` links to the replacement memory's ID (forms a chain)
- A memory with `validUntil !== null` is "expired" — still in the graph but excluded from default recall

### 2.2 Neo4j Index Changes

Add a composite index for temporal queries:

```cypher
CREATE INDEX memory_temporal IF NOT EXISTS
FOR (m:Memory) ON (m.validUntil, m.validFrom)
```

### 2.3 Conflict Detection on `memory_store`

When storing a new memory, detect and supersede conflicting existing memories:

**Algorithm:**

1. After computing the embedding for the new memory, run a vector similarity search (cosine > 0.82) against existing memories
2. Filter candidates to same category OR overlapping entity references
3. For each candidate with similarity > 0.82:
   a. Use LLM to classify: `SUPERSEDES`, `COMPLEMENTS`, or `UNRELATED`
   b. If `SUPERSEDES`: set candidate's `validUntil = now()`, `supersededBy = newMemoryId`
4. Store the new memory with `validFrom = now()`, `validUntil = null`

**LLM Prompt for Conflict Classification:**

```
Given two memories about potentially the same topic:
EXISTING: "{existing_memory_text}"
NEW: "{new_memory_text}"

Classify the relationship:
- SUPERSEDES: The new memory replaces/updates/contradicts the existing one
- COMPLEMENTS: The new memory adds to the existing one (both remain valid)
- UNRELATED: The memories are about different things despite textual similarity

Reply with exactly one word: SUPERSEDES, COMPLEMENTS, or UNRELATED
```

**Performance guard:** Max 5 candidates checked per store operation. Use the cheapest available model (configured via `memory.conflictModel` or fallback to the memory extraction model).

### 2.4 Temporal Filtering in `memory_recall`

Modify the three search signals (vector, BM25, graph) to exclude expired memories by default:

```cypher
-- Add to WHERE clause of all search queries:
AND m.validUntil IS NULL
```

Add an optional `includeExpired: boolean` parameter to the recall interface for historical queries.

### 2.5 Sleep Cycle Integration

**Phase 3b enhancement:** The existing temporal staleness check (`fetchMemoriesForTemporalCheck`) should also consider `validUntil`. Memories already marked as superseded should be skipped (they're already resolved).

**New Phase 3c — Retroactive Conflict Scan:**
For memories older than 7 days that haven't been checked, run the conflict detection algorithm (§2.3) against newer memories in the same category. This catches conflicts that were missed at store time (e.g., before this feature existed). Run max 20 memories per sleep cycle to limit LLM cost.

### 2.6 Migration

Backfill existing memories:

- Set `validFrom = COALESCE(originalCreatedAt, createdAt)` for all existing memories
- Set `validUntil = null` for all existing memories (assume all currently valid)
- Set `supersededBy = null` for all existing memories

This is a non-breaking migration — all existing memories remain valid.

### 2.7 CLI Support

Add a `--include-expired` flag to the memory CLI's recall/search commands:

```bash
openclaw memory recall "theme preference" --include-expired
```

Add a `memory supersede` command for manual override:

```bash
openclaw memory supersede <old-memory-id> <new-memory-id>
```

---

## 3. Files to Modify

| File              | Changes                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`       | Add `validFrom`, `validUntil`, `supersededBy` to `MemoryNode` type. Add to `StoreMemoryInput`.                                                                                                                                                                                                                   |
| `neo4j-client.ts` | (1) `storeMemory()`: set `validFrom` default. (2) `ensureIndexes()`: add temporal index. (3) All search methods: add `validUntil IS NULL` filter. (4) New `supersededMemory()` method. (5) New `detectConflicts()` method. (6) `fetchMemoriesForTemporalCheck()`: skip already-superseded. (7) Migration method. |
| `search.ts`       | Add `includeExpired` option to search interface, pass through to neo4j-client.                                                                                                                                                                                                                                   |
| `index.ts`        | Wire conflict detection into `memory_store` flow. Add `includeExpired` to `memory_recall`.                                                                                                                                                                                                                       |
| `sleep-cycle.ts`  | Add Phase 3c retroactive conflict scan. Update Phase 3b to skip superseded memories.                                                                                                                                                                                                                             |
| `cli.ts`          | Add `--include-expired` flag. Add `memory supersede` command.                                                                                                                                                                                                                                                    |
| `config.ts`       | Add `memory.conflictDetection.enabled` (default: true), `memory.conflictDetection.model` (optional override), `memory.conflictDetection.threshold` (default: 0.82).                                                                                                                                              |

---

## 4. Test Plan

| Test                           | File                   | Description                                                                               |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------- |
| Store with conflict detection  | `neo4j-client.test.ts` | Store memory A, then store contradicting memory B → A gets `validUntil` set, B is current |
| Recall filters expired         | `search.test.ts`       | Superseded memory not returned by default recall                                          |
| Recall with includeExpired     | `search.test.ts`       | Superseded memory IS returned when `includeExpired: true`                                 |
| Complementary memories coexist | `neo4j-client.test.ts` | Two related but non-contradicting memories both remain valid                              |
| Migration backfill             | `neo4j-client.test.ts` | Existing memories get `validFrom` set from `originalCreatedAt`                            |
| Sleep cycle Phase 3c           | `sleep-cycle.test.ts`  | Retroactive scan finds and supersedes old conflicts                                       |
| Manual supersede via CLI       | `cli.test.ts`          | `memory supersede` correctly links two memories                                           |
| Performance guard              | `neo4j-client.test.ts` | Max 5 candidates checked regardless of similarity matches                                 |

---

## 5. Configuration

```yaml
memory:
  conflictDetection:
    enabled: true # Enable/disable on-store conflict detection
    model: null # LLM model override (null = use extraction model)
    similarityThreshold: 0.82 # Cosine similarity threshold for candidate selection
    maxCandidates: 5 # Max memories to check per store
    sleepScanBatchSize: 20 # Max memories to retroactively scan per sleep cycle
```

---

## 6. Non-Goals (Deferred)

- **Full Graphiti-style episodic edges**: Graphiti maintains directed typed edges between entities with validity periods. This spec only adds validity to memory nodes themselves, not entity-to-entity relationships. Entity relationship evolution is deferred to a future OP.
- **Automatic `validFrom` inference from memory text**: e.g., parsing "Since January I prefer..." to set `validFrom` to January. Deferred — use `createdAt` as default for now.
- **UI for temporal memory browsing**: Deferred — CLI is sufficient for v1.

---

## 7. Rollback Plan

- Feature is gated behind `memory.conflictDetection.enabled` (default: true)
- Set to `false` to disable conflict detection without code changes
- Temporal fields are additive — existing queries work unchanged if `validUntil IS NULL` filters are removed
- Migration is non-destructive (adds fields, doesn't remove anything)
