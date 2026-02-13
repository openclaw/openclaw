# SPEC: Rolling Context Window

## Problem

When sessions grow long, OpenClaw compacts by summarizing old messages into a lossy summary. This loses detail and creates "telephone effect" — summaries of summaries degrade over time. Meanwhile, all messages are already persisted to JSONL transcripts on disk and indexed for embedding search.

## Solution

Add a new compaction mode: `"rolling"` that drops old messages without summarization, trusting the memory/recall system to retrieve anything needed later.

## Architecture

### Context layout (unchanged):

```
[System Prompt] [Injected Files] [Previous Summary*] [Conversation History]
```

\*With rolling mode, "Previous Summary" becomes a minimal eviction note, not a full summary.

### How rolling mode works:

1. **Trigger:** Same as existing compaction — when context nears the model's token limit
2. **Eviction:** Drop the oldest N messages from conversation history to bring context back under threshold (target: ~80% of context window)
3. **No summarization:** Skip the `generateSummary()` call entirely. No model call = no cost, no latency, no information loss through summarization.
4. **Eviction note:** Replace dropped messages with a single system message:
   ```
   [Context rolled: N messages evicted. Full transcript searchable via memory_search.
    Evicted range: <first_timestamp> to <last_timestamp>]
   ```
5. **Transcript persistence:** Already handled — messages are written to JSONL before eviction. No change needed.
6. **Memory indexing:** Already handled — session transcripts are indexed by the memory search system. Evicted messages remain searchable.

### Configuration:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "rolling",
        "rolling": {
          "targetUtilization": 0.8, // Keep context at ~80% capacity after eviction
          "minKeepMessages": 10, // Always keep at least N recent messages
          "evictionNote": true // Insert eviction marker (default true)
        }
      }
    }
  }
}
```

### Fallback:

If `rolling` mode is configured but memory search is not enabled, fall back to `safeguard` mode with a warning log. Rolling mode without recall is amnesia.

## Implementation

### Files to modify:

1. **`src/agents/compaction.ts`** — Add `rollingEvict()` function that drops messages and returns eviction metadata (count, timestamp range, token savings). No summarization.

2. **`src/agents/pi-embedded-runner/compact.ts`** — In `compactEmbeddedPiSessionDirect()`, check compaction mode. If `"rolling"`, call `rollingEvict()` instead of `session.compact()`. Insert eviction note message. Return result.

3. **`src/config/config.ts`** (or equivalent) — Add `"rolling"` to compaction mode enum. Add `rolling` sub-config schema.

4. **`src/agents/pi-extensions/compaction-safeguard.ts`** — No changes needed (rolling bypasses safeguard entirely).

### New function signature:

```typescript
export function rollingEvict(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  targetUtilization?: number; // default 0.8
  minKeepMessages?: number; // default 10
}): {
  kept: AgentMessage[];
  evicted: AgentMessage[];
  evictedCount: number;
  evictedTokens: number;
  keptTokens: number;
  firstEvictedTimestamp?: number;
  lastEvictedTimestamp?: number;
};
```

### Eviction note message:

```typescript
const evictionNote: AgentMessage = {
  role: "system",
  content:
    `[Context rolled: ${result.evictedCount} messages evicted (${result.evictedTokens} tokens). ` +
    `Full transcript available via memory_search. ` +
    `Evicted range: ${formatTimestamp(result.firstEvictedTimestamp)} to ${formatTimestamp(result.lastEvictedTimestamp)}]`,
  timestamp: Date.now(),
};
```

## Testing

1. Unit tests for `rollingEvict()` — correct eviction count, respects minKeepMessages, correct token math
2. Integration test — session with rolling mode triggers eviction instead of summarization
3. Verify evicted messages remain searchable via memory_search
4. Verify fallback to safeguard when memory search disabled

## Migration

- Default mode remains `"default"` — no breaking changes
- Users opt in via config: `compaction.mode: "rolling"`
- We (Hal's fork) will default to rolling once validated

## Non-goals (for now)

- Selective eviction (keep "important" messages) — adds complexity, dubious value if recall works
- Streaming eviction (drop one message at a time) — batch eviction is simpler and sufficient
- Summary + rolling hybrid — if we need summaries, use safeguard mode
