# RFC: Progressive Memory Flush for OpenClaw Sessions

## Summary

This RFC proposes a **Progressive Memory Flush** mechanism inspired by biological autophagy to progressively clean up session memory in three stages: **soft flush** (non-essential metadata), **compact flush** (summarization via LLM), and **hard flush** (complete context reset with archival).

---

## Motivation: Biological Autophagy as Design Metaphor

In biology, **autophagy** (自噬) is the cell's self-cleaning mechanism:

1. **Selective degradation** — cells identify and remove damaged/unnecessary components
2. **Graduated response** — from minor cleanup to complete organelle recycling
3. **Survival-preserving** — core functions survive even during aggressive cleanup
4. **Triggered by stress** — activated by nutrient deprivation, aging, or damage

OpenClaw's current compaction is analogous to a "full system reboot" — effective but wasteful. A **progressive flush** would:

- Remove non-essential context earlier (like removing cytoplasm first)
- Preserve critical session identity longer (like keeping the nucleus)
- Use summarization as "molecular recycling" (repackaging old content)
- Eventually archive rather than delete (like DNA preservation)

**Core insight**: Not all session history is equally valuable. Recent turns carry most signal; distant turns are mostly noise that consumes context window.

---

## Current Behavior

### Existing Compaction Mechanism

OpenClaw currently supports **compaction** (会话压缩) which:

1. **Triggered manually** via `session.compact()` or automatically
2. **Replaces conversation history** with a system message summarizing the session
3. **Preserves transcript** in `*.jsonl` with compaction markers
4. **Uses LLM** to generate a summary from recent messages

### Current Limitations

| Aspect | Current Behavior | Limitation |
|--------|------------------|------------|
| **Granularity** | All-or-nothing compaction | No partial cleanup |
| **Trigger** | Manual or explicit threshold | No progressive triggers |
| **Metadata** | Retained indefinitely | Metadata bloat over time |
| **Archival** | No separate archival layer | Can't access old data without restoring |
| **Context budget** | Single context window | No tiered context management |

---

## Proposed: Three-Stage Progressive Flush

### Stage 1: Soft Flush (Metadata Pruning)

**When triggered**: After N turns (configurable, default: 50) or token threshold

**What happens**:
- Remove ephemeral metadata from older messages:
  - Message IDs, timestamps (beyond retention window)
  - Temporary flags, debug annotations
  - Redundant system prompts from earlier turns
- **Preserve**: Actual conversation content, tool call history, key decisions
- **Result**: ~10-20% token reduction without semantic loss

**Analogy**: Autophagy — removing damaged proteins and free radicals

### Stage 2: Compact Flush (LLM Summarization)

**When triggered**: After N soft flushes (default: 3) or token threshold exceeded

**What happens**:
- Invoke LLM to summarize accumulated conversation segments
- Replace original messages with a **compact summary** + **key artifacts**:
  - Summary: "Session covered X topics, user asked about Y, tool Z was used..."
  - Preserved: Final tool outputs, critical decisions, user preferences
- **Result**: ~70-80% token reduction while preserving essential context

**Analogy**: Macroautophagy — wrapping up bulk cellular components into autophagosomes

### Stage 3: Hard Flush (Archive + Reset)

**When triggered**: When context window exhausted or session marked for archival

**What happens**:
- Archive full transcript to `*.archive.jsonl.gz`
- Create new transcript with **session seed**:
  - Original session key and creation time
  - Compact summary from Stage 2
  - Critical user preferences and tool results
- Mark original transcript as read-only archive
- **Result**: Fresh session with minimal but complete context

**Analogy**: Apoptosis with DNA preservation — cell dies but genetic information survives

---

## Implementation Plan

### Phase 1: Infrastructure (v0.x)

1. **Add flush configuration** to `session.maintenance`:
   ```typescript
   interface FlushConfig {
     softFlushAfterTurns: number;      // default: 50
     compactFlushAfterSoftFlushes: number; // default: 3
     preserveMetadata: string[];        // fields to never remove
     archiveFormat: 'jsonl.gz' | 'json';
   }
   ```

2. **Implement Soft Flush**:
   - Add `session.softFlush()` method
   - Strip metadata from messages older than threshold
   - Add `__flush` marker to indicate soft-flushed entries

3. **Add archival storage**:
   - `sessions/<sessionId>.archive.jsonl.gz`
   - Archive index in `sessions.json`

### Phase 2: Compact Flush (v0.y)

1. **Implement Compact Flush**:
   - Add `session.compactFlush()` method
   - Integrate with existing LLM summarization
   - Preserve critical artifacts (tool results, decisions)

2. **Add tiered context**:
   - Hot context: Recent N turns
   - Warm context: Summarized segments
   - Cold context: Archive (load on demand)

### Phase 3: Hard Flush (v0.z)

1. **Implement Hard Flush**:
   - Add `session.hardFlush()` method
   - Archive full transcript
   - Reset with seed context

2. **Add restore capability**:
   - `session.restoreFromArchive(archiveId)`
   - Merge archived context back into active session

### Phase 4: Integration & Tuning

1. **Auto-trigger rules**:
   - Token threshold → Soft Flush
   - Accumulated soft flushes → Compact Flush
   - Context exhaustion → Hard Flush

2. **Metrics & observability**:
   - Track flush effectiveness (tokens saved)
   - Monitor context window utilization
   - Alert on excessive flushing (session may have issues)

---

## Configuration Example

```json
{
  "session": {
    "maintenance": {
      "mode": "enforce",
      "flush": {
        "softFlushAfterTurns": 50,
        "compactFlushAfterSoftFlushes": 3,
        "preserveMetadata": ["role", "content", "tool_calls", "user_preference"],
        "archiveFormat": "jsonl.gz"
      }
    }
  }
}
```

---

## Backward Compatibility

- **Default config preserves current behavior**: set `flush: null` to disable
- **Existing compaction** continues to work as "manual compact flush"
- **Archives are read-only**: no risk of data loss during migration

---

## Open Questions

1. **Summarization quality**: How to ensure compact summaries retain critical information?
2. **Archive access**: Should archived sessions be loadable automatically or on-demand only?
3. **Cross-session memory**: Should preferences be extracted to a separate user profile?

---

## Related Documents

- `/concepts/compaction` — existing compaction concept
- `/reference/session-management-compaction` — deep dive on current implementation
- `/concepts/session-pruning` — session cleanup concepts

---

# PR Ready: Commit Message & Body

## Commit Message

```
feat(session): add progressive memory flush with 3-stage autophagy-inspired cleanup

Introduces soft flush (metadata pruning), compact flush (LLM summarization),
and hard flush (archive + reset) for progressive session memory management.

Closes #43006
```

## PR Body

## Summary

Add a progressive memory flush mechanism inspired by biological autophagy, with three cleanup stages: **soft flush** (metadata pruning), **compact flush** (LLM summarization), and **hard flush** (archive + context reset).

## Context

Current OpenClaw compaction is an all-or-nothing "full reboot" — effective but wasteful. Session history accumulates metadata bloat, and there's no tiered context management. Recent turns carry most signal; distant turns are mostly noise consuming context window.

This RFC draws an analogy to biological autophagy:
- **Selective degradation** — cells remove damaged/unnecessary components first
- **Graduated response** — from minor cleanup to complete recycling
- **Survival-preserving** — core functions survive even during aggressive cleanup
- **Archive rather than delete** — DNA preservation pattern

## Proposed Changes

### Phase 1: Infrastructure
- Add `flush` config to `session.maintenance` (softFlushAfterTurns, compactFlushAfterSoftFlushes, preserveMetadata, archiveFormat)
- Implement `session.softFlush()` — strip ephemeral metadata from older messages
- Add archival storage (`sessions/<sessionId>.archive.jsonl.gz`)

### Phase 2: Compact Flush
- Implement `session.compactFlush()` — LLM summarization of accumulated segments
- Add tiered context: hot (recent), warm (summarized), cold (archive)

### Phase 3: Hard Flush
- Implement `session.hardFlush()` — archive full transcript, reset with seed context
- Add `session.restoreFromArchive()` for on-demand restoration

### Phase 4: Auto-trigger Integration
- Token threshold → Soft Flush
- Accumulated soft flushes → Compact Flush
- Context exhaustion → Hard Flush
- Metrics: track tokens saved, context utilization

### Configuration

```json
{
  "session": {
    "maintenance": {
      "flush": {
        "softFlushAfterTurns": 50,
        "compactFlushAfterSoftFlushes": 3,
        "preserveMetadata": ["role", "content", "tool_calls", "user_preference"],
        "archiveFormat": "jsonl.gz"
      }
    }
  }
}
```

### Backward Compatibility

- Default config preserves current behavior (set `flush: null` to disable)
- Existing compaction works as manual compact flush
- Archives are read-only

## Testing Plan

- Unit tests for each flush stage
- Integration tests for auto-trigger rules
- Token savings measurement
- Archive restore verification

---

Closes #43006
