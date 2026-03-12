# Bot History: Pending Flush to Session Transcript

## Problem

When the bot sends proactive messages (cron jobs, scheduled tasks) to a Telegram chat, these messages are not included in the LLM's conversation context. When a user asks about those messages, the LLM denies having sent them.

### Root Cause

- Cron delivery calls `deliverOutboundPayloads` **without** the `mirror` parameter
- Without `mirror`, the delivered text is never written to any session transcript
- The Telegram inbound handler's `groupHistories` only records **user** messages, not bot outbound messages
- The cron agent's session is isolated from the Telegram chat's session — they use different session keys

### Example

1. Cron sends "抢到红包！金额: 3 USDC" to a Telegram group
2. User replies "真的么？"
3. Bot says "我没说过..." (denies its own message)

## Solution: Pending Buffer + Flush at Inbound

A two-phase approach that bridges cron delivery and session transcripts without coupling the delivery layer to session management.

**Phase 1 (Delivery time):** Record the delivered text to a lightweight JSON store keyed by `channel + to + threadId`.

**Phase 2 (Inbound time):** When a user message arrives, flush pending entries into the correct session transcript using the existing `appendAssistantMessageToSessionTranscript` infrastructure.

### Why This Approach

- **Reuses existing infrastructure**: `appendAssistantMessageToSessionTranscript` is already production-ready (used by the `mirror` flow in `deliver.ts`)
- **No cross-layer coupling**: Delivery layer writes to a simple buffer; session key resolution stays in the inbound handler where it naturally belongs
- **Persistent**: JSON file survives restarts (unlike in-memory-only approaches)
- **Channel-agnostic**: Works for any channel, not just Telegram

## Components

### 1. Pending Bot History Store

**File**: `src/auto-reply/reply/bot-history.ts`

Follows the cron store pattern (`src/cron/store.ts`): JSON file + atomic write (tmp + rename) + in-memory cache.

**Store path**: `~/.openclaw/bot-history/pending.json`

```typescript
type BotHistoryEntry = {
  id: string; // unique identifier (crypto.randomUUID())
  channel: string; // "telegram", "discord", etc.
  to: string; // delivery target in codebase format (e.g., "telegram:-100123456")
  accountId?: string; // optional account discriminator
  threadId?: string; // optional thread/topic ID (Telegram forum topics)
  text: string; // delivered text content
  timestamp: number; // Date.now()
  source?: string; // origin: "cron" | "heartbeat" | "manual" (for debugging)
};

type BotHistoryStore = {
  version: 1;
  entries: BotHistoryEntry[];
};
```

**Exported functions:**

- `appendBotHistoryEntry(entry: Omit<BotHistoryEntry, 'id'>)` — Append an entry to the store (delivery time). Generates `id` via `crypto.randomUUID()` internally. Also triggers compaction when entry count exceeds threshold.
- `readBotHistoryEntries({ channel, to, accountId?, threadId? })` — Read matching entries without removing them. Matching uses strict equality: `entry.accountId === query.accountId` and `entry.threadId === query.threadId` (both `undefined` = match; different values = no match). This ensures cron delivery to account-A is only flushed when inbound is also from account-A.
- `removeBotHistoryEntries(ids: string[])` — Remove specific entries by `id` (after successful flush)
- `flushBotHistoryToTranscript({ channel, to, accountId?, threadId?, sessionKey, agentId })` — Read matching entries, write each to session transcript, remove only successfully flushed entries
- `compactBotHistoryStore()` — Remove entries older than TTL. Called lazily: on first store load, and when entry count exceeds threshold during `appendBotHistoryEntry`. No dedicated startup hook needed — the first read or write triggers compaction if stale entries exist.

**Constraints:**

- Max 500 entries total (prevents unbounded growth)
- 24-hour TTL (entries older than this are discarded on compaction)
- Atomic write with tmp + rename (crash-safe)
- In-memory cache to avoid unnecessary file I/O (same pattern as `serializedStoreCache` in cron store)

### 2. Recording Point

**File**: `src/cron/isolated-agent/delivery-dispatch.ts`

**Location**: Inside the `deliverViaDirect` closure, immediately after `delivered = deliveryResults.length > 0` (line 275). This is the single point where actual channel delivery happens — it captures both the direct delivery path (line 454) and the `finalizeTextDelivery` path (line 411). Early returns before this point (active subagent runs, interim message suppression, silent reply) never reach actual delivery, so no recording is needed for those.

```typescript
delivered = deliveryResults.length > 0;
if (delivered && synthesizedText?.trim()) {
  appendBotHistoryEntry({
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    threadId: delivery.threadId != null ? String(delivery.threadId) : undefined,
    text: synthesizedText.trim(),
    timestamp: Date.now(),
    source: "cron",
  }).catch(() => {}); // best-effort, don't block delivery
}
return null;
```

**Why inside `deliverViaDirect` (not at function end or in `deliver.ts`):**

- `dispatchCronDelivery` has 8+ early return paths; placing at function end would miss deliveries that exit early
- `deliverViaDirect` is the single funnel — ALL successful cron channel sends go through it
- Closure captures `synthesizedText` from outer scope — no parameter threading needed
- `delivery` parameter is already typed as `SuccessfulDeliveryTarget` — no `.ok` guard needed
- More targeted than `deliver.ts` — only records cron deliveries, which are the actual problem
- Other non-mirror, non-cron outbound paths (heartbeat, webhook-triggered push, etc.) can add their own recording at the source with the appropriate `source` tag

> **Note for implementers:** Add a code comment at the recording site explaining that other proactive outbound paths should add their own `appendBotHistoryEntry` call if they also bypass the `mirror` parameter.

### 3. Flush Point

**File**: `src/auto-reply/reply/get-reply.ts`

**Location**: In `getReplyFromConfig()`, after `initSessionState()` and before `runPreparedReply()`.

```typescript
// existing code:
const sessionState = await initSessionState({ ctx: finalized, cfg, commandAuthorized });
let { sessionKey /* ...other destructured fields... */ } = sessionState;

// ──── INSERT HERE ────
// Flush pending bot messages into the current session transcript
await flushBotHistoryToTranscript({
  channel: finalized.OriginatingChannel,
  to: finalized.OriginatingTo,
  accountId: finalized.AccountId,
  threadId: finalized.MessageThreadId != null ? String(finalized.MessageThreadId) : undefined,
  sessionKey,
  agentId,
}).catch(() => {}); // best-effort
```

**Why here:**

- `getReplyFromConfig` is the unified entry point for all channels (channel-agnostic)
- After `initSessionState()` + destructuring: `sessionKey` is available and session is guaranteed to exist
- Before agent execution: transcript will include flushed messages when loaded
- `finalized` (the inbound context) already carries `OriginatingChannel`, `OriginatingTo`, `AccountId`, and `MessageThreadId` (verified in `src/auto-reply/templating.ts:49,149`) — no new parameters needed

> **Note:** Some fast-abort paths in `dispatch-from-config.ts` short-circuit before reaching `getReplyFromConfig`. Those paths produce non-agent replies and won't trigger a flush. Pending entries will be flushed on the next full agent reply turn. This is acceptable since fast-abort replies don't involve LLM context.

### `flushBotHistoryToTranscript` Implementation

```typescript
export async function flushBotHistoryToTranscript(params: {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  sessionKey: string;
  agentId: string;
}): Promise<number> {
  const entries = await readBotHistoryEntries({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  });
  if (entries.length === 0) return 0;

  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Flush each entry to the session transcript individually.
  // Only remove entries that were successfully written — if a write fails,
  // the entry stays in the pending store for the next flush attempt.
  const flushedIds: string[] = [];
  for (const entry of entries) {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      text: entry.text,
    });
    if (result.ok) {
      flushedIds.push(entry.id);
    }
  }

  if (flushedIds.length > 0) {
    await removeBotHistoryEntries(flushedIds);
  }
  return flushedIds.length;
}
```

**Key detail:** Entries are read without removal, then only successfully flushed entries are removed. This prevents data loss if `appendAssistantMessageToSessionTranscript` fails partway through a batch.

## Data Flow

```
Cron Agent Turn
  │
  ▼
  synthesizedText = "🧧 抢到红包！金额: 3 USDC"
  │
  ▼
  deliverOutboundPayloads() → Telegram API sends message
  │
  ▼
  appendBotHistoryEntry()
  → ~/.openclaw/bot-history/pending.json
    { id:"a1b2c3...", channel:"telegram", to:"telegram:-100xxx",
      text:"🧧 抢到红包！...", timestamp:1741795200000, source:"cron" }

                ⏳ User sees the message...

Telegram Inbound: "真的么？"
  │
  ▼
  getReplyFromConfig(ctx)
  │
  ▼
  initSessionState() → session exists
  │
  ▼
  flushBotHistoryToTranscript()
  → reads pending.json, finds matching channel+to+threadId entries
  → appendAssistantMessageToSessionTranscript() writes to session transcript
  → removes only successfully flushed entries from pending.json
  │
  ▼
  runPreparedReply() → agent loads transcript
  │
  ▼
  LLM sees:
    [assistant] 🧧 抢到红包！金额: 3 USDC
    [user] 真的么？
  │
  ▼
  LLM replies: "是的，你抢到了 3 USDC"
```

## Edge Cases

| Scenario                                                  | Behavior                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session doesn't exist yet (first message in chat)         | `initSessionState()` creates the session before flush runs                                                                                                                                                                                                                 |
| No pending entries                                        | Flush reads cache, finds nothing, returns immediately (negligible overhead)                                                                                                                                                                                                |
| Cron sends multiple messages before user replies          | All entries accumulate, flushed in chronological order on next inbound                                                                                                                                                                                                     |
| Process restarts between cron delivery and user message   | Entries persisted to JSON file, restored on startup                                                                                                                                                                                                                        |
| Entries older than 24h                                    | Removed by `compactBotHistoryStore()` on startup                                                                                                                                                                                                                           |
| Multiple users ask about the same cron message in a group | First user's message triggers flush to transcript; subsequent messages in the same session see it in the transcript                                                                                                                                                        |
| DM cron delivery                                          | Same flow — channel + to matching works for both DM and group                                                                                                                                                                                                              |
| Telegram forum topics                                     | `threadId` is captured at recording and matched at flush; different topics in the same group map to different session keys, so entries go to the correct transcript                                                                                                        |
| Multi-account setup                                       | `accountId` matching prevents cross-account pollution (cron delivery from account-A won't be flushed into account-B's session)                                                                                                                                             |
| Partial flush failure                                     | Only successfully written entries are removed from pending store; failed entries remain for retry on the next inbound message                                                                                                                                              |
| Concurrent cron delivery + inbound message                | Node.js single-threaded event loop; atomic file writes ensure consistency                                                                                                                                                                                                  |
| Concurrent flush from two users in same group             | Both handlers may read the same pending entries between await points; worst case is a duplicate assistant message in the transcript, which is harmless for LLM context quality. Accepted trade-off for v1 — a per-key flush lock can be added if this becomes a real issue |

## Changes Summary

| File                                           | Change                                    | Estimated Lines |
| ---------------------------------------------- | ----------------------------------------- | --------------- |
| `src/auto-reply/reply/bot-history.ts`          | **New** — pending store + flush functions | ~120            |
| `src/cron/isolated-agent/delivery-dispatch.ts` | Record entry after successful delivery    | +8              |
| `src/auto-reply/reply/get-reply.ts`            | Flush after `initSessionState()`          | +6              |
| `src/auto-reply/reply/bot-history.test.ts`     | **New** — unit tests                      | ~150            |

Total: ~300 lines of new code, 2 small insertion points. No changes to existing interfaces or types.

## Testing Strategy

- **Unit: `bot-history.test.ts`** — append, flush, compact, TTL expiry, max entries limit, atomic write safety
- **Unit: `delivery-dispatch`** — mock `appendBotHistoryEntry`, verify called when `delivered && synthesizedText`
- **Unit: `get-reply`** — mock `flushBotHistoryToTranscript`, verify called after `initSessionState` with correct sessionKey
- **Integration** — cron delivery → pending entry exists → inbound message → session transcript contains bot message → LLM context includes it
