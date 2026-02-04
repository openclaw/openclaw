# WORK-QUEUE: Progressive Memory System

> **Design Doc**: `docs/plans/2026-02-04-progressive-memory-system-design.md`
> **Assigned Agent**: `clawdbrain` (spawned sub-agent)
> **Repo**: `/Users/dgarson/clawd/clawdbrain`
> **Branch prefix**: `feature/progressive-memory-`
> **Build/test**: `cd /Users/dgarson/clawd/clawdbrain && pnpm build && pnpm test`
> **Last updated**: 2026-02-04 09:10 MST

## ⚠️ CRITICAL RULES

1. **NEVER modify** `src/agents/tools/memory-tool.ts` — this is the existing memory system. DO NOT TOUCH.
2. **NEVER modify** `src/memory/manager.ts` or any existing memory/\* files unless explicitly adding new integration points.
3. **ALL new tools** go in NEW files with the `progressive-` or `memory-` prefix.
4. **Notify David** (Slack #cb-inbox C0AAP72R7L5) at the START and COMPLETION of each task.
5. **Run `pnpm build && pnpm test`** before pushing anything.
6. **Create feature branch** before starting each task.

## Status Key

- `[ ]` — Available
- `[~]` — In progress
- `[x]` — Complete
- `[!]` — Blocked

---

## Phase 1: Core Infrastructure (New Tools — No Breaking Changes)

### T1: Progressive Store SQLite Backend

- [x] **What**: Create the structured SQLite store for categorized memory entries.
- **Create**: `src/memory/progressive-store.ts`
- **Schema**: See design doc §2.6
- **Requirements**:
  - CRUD operations for memory entries
  - FTS5 full-text search
  - Vector similarity search (sqlite-vec)
  - Deduplication check (cosine similarity > 0.92 = duplicate)
  - Token estimation per entry
  - Auto-archive on expiry
  - All operations are idempotent
- **Tests**: `src/memory/progressive-store.test.ts`
- **Branch**: `feature/progressive-memory-store`
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

### T2: memory_store Tool

- [x] **What**: MCP tool for structured memory writes.
- **Create**: `src/agents/tools/memory-store-tool.ts`
- **Parameters**: category, content, context, priority, tags, related_to, expires
- **Behavior**:
  1. Validate input
  2. Check for duplicates (embed + cosine similarity)
  3. Store in progressive.db
  4. Generate/update domain markdown file in memory/domains/<category>.md
  5. Return entry ID, dedup status, token cost
- **Tests**: `src/agents/tools/memory-store-tool.test.ts`
- **Branch**: `feature/progressive-memory-store` (same as T1)
- **Depends on**: T1
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

### T3: memory_recall Tool

- [x] **What**: Smart retrieval with structured queries and token budget.
- **Create**: `src/agents/tools/memory-recall-tool.ts`
- **Parameters**: query, categories, priority_min, token_budget, include_context, format
- **Behavior**:
  1. Search progressive store (hybrid: FTS + vector)
  2. Filter by category and priority
  3. Rank by relevance score
  4. Clamp to token budget
  5. Fall back to `memory_search` for any queries that return no results (backward compat)
  6. Return structured entries with token count
- **Tests**: `src/agents/tools/memory-recall-tool.test.ts`
- **Branch**: `feature/progressive-memory-recall`
- **Depends on**: T1
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

### T4: memory_index_status Tool

- [x] **What**: Health and statistics for both memory systems.
- **Create**: `src/agents/tools/memory-index-status-tool.ts`
- **Returns**: Stats for legacy system (files, chunks, tokens) + progressive system (entries by category/priority, domain files, token estimates)
- **Branch**: `feature/progressive-memory-status`
- **Depends on**: T1
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

### T5: Register New Tools

- [x] **What**: Register all new tools in the OpenClaw tool registry.
- **Modify**: `src/agents/pi-tools.ts` (or equivalent registration point)
- **Add**: memory_store, memory_recall, memory_index_status alongside existing memory_search, memory_get
- **Ensure**: New tools only appear when progressive memory is enabled in config
- **Config key**: `memory.progressive.enabled: true`
- **Branch**: `feature/progressive-memory-registration`
- **Depends on**: T2, T3, T4
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

---

## Phase 2: Migration & Index Generation

### T6: MEMORY.md Parser & Migrator

- [x] **What**: Parse existing MEMORY.md into categorized entries and populate the progressive store.
- **Create**: `scripts/migrate-memory-to-progressive.ts`
- **Behavior**:
  1. Read MEMORY.md
  2. Parse sections into semantic categories (People → person, Preferences → preference, etc.)
  3. Assign priorities (channel IDs → critical, preferences → high, project details → medium)
  4. Store each entry via progressive store API
  5. Generate domain files in memory/domains/
  6. Support --dry-run flag
  7. Support --verify flag (compare recall results against memory_search)
- **Safety**: MEMORY.md is NEVER modified. Only reads from it.
- **Branch**: `feature/progressive-memory-migration`
- **Depends on**: T1, T2
- **Verify**: `pnpm build && node --import tsx scripts/migrate-memory-to-progressive.ts --dry-run`
- **Notify**: Start + completion to #cb-inbox

### T7: Memory Index Generator

- [x] **What**: Generate the lean always-loaded memory index from the progressive store.
- **Create**: `src/memory/progressive-index.ts`
- **Behavior**:
  1. Query all entries from progressive store
  2. Group by category
  3. Generate compressed markdown index (<1500 tokens)
  4. Critical entries get full text; lower priority get one-line summaries
  5. Include "use memory_recall to load more" hints
  6. Write to `memory/MEMORY-INDEX.md` (human-readable backup)
- **Branch**: `feature/progressive-memory-index`
- **Depends on**: T1, T6
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

---

## Phase 3: System Prompt Integration

### T8: System Prompt — Progressive Memory Section

- [x] **What**: Add progressive memory awareness to the system prompt.
- **Modify**: `src/agents/system-prompt.ts`
- **Changes**:
  1. When progressive memory is enabled, inject MEMORY-INDEX.md content instead of referencing full MEMORY.md
  2. Add instruction to use `memory_recall` for domain-specific queries
  3. Keep existing `memory_search`/`memory_get` fallback instructions
  4. Add instruction to use `memory_store` when learning new facts/preferences
- **Safety**: Behind `memory.progressive.enabled` config flag. When disabled, system prompt is identical to current.
- **Branch**: `feature/progressive-memory-prompt`
- **Depends on**: T5, T7
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

---

## Phase 4: Token Audit

### T9: memory_audit Tool

- [x] **What**: Token analysis and optimization recommendations.
- **Create**: `src/agents/tools/memory-audit-tool.ts`
- **Behavior**:
  1. Count tokens in MEMORY.md, memory/\*.md, system prompt sections, skill metadata
  2. Detect duplicates across sources (embed + compare)
  3. Identify stale entries (not accessed in 30+ days)
  4. Generate prioritized optimization recommendations
  5. Estimate token savings per recommendation
- **Branch**: `feature/progressive-memory-audit`
- **Depends on**: T1
- **Verify**: `pnpm build && pnpm test`
- **Notify**: Start + completion to #cb-inbox

### T10: Run Initial Audit & Apply Recommendations

- [x] **What**: Run the audit tool against current memory and apply safe optimizations.
- **Execution**:
  1. Run memory_audit with scope="all", recommend=true
  2. Review recommendations
  3. Apply any "low risk" recommendations
  4. Document results
- **Safety**: Only apply "low risk" recommendations. Medium/high risk go to David for review.
- **Depends on**: T9
- **Notify**: Start + completion to #cb-inbox with audit results

---

## Completion

When all phases are complete:

1. Update the design doc with actual implementation details
2. Post final summary to #cb-inbox with:
   - What was built
   - Token savings measured
   - Any issues or deviations from design
   - Future enhancement recommendations
3. Mark all tasks [x] in this file
