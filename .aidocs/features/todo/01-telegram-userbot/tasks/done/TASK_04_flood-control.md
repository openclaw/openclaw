# TASK_04: Flood Control

<!-- SUMMARY: Rate-limits outbound operations to prevent Telegram account bans from aggressive usage patterns -->

## Metadata

| Field           | Value               |
| --------------- | ------------------- |
| **Complexity**  | normal              |
| **Est. Tokens** | ~15k                |
| **Priority**    | P0                  |
| **Created**     | 2026-03-02          |
| **Feature**     | 01-telegram-userbot |
| **Phase**       | 1                   |
| **Wave**        | 1                   |

---

## SDD References

| Document  | Path                                                               | Sections                                                        |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Spec      | `.aidocs/features/todo/01-telegram-userbot/spec.md`                | §5 Risks (Flood wait, Account ban), §7 Constraints (30 msg/sec) |
| Design    | `.aidocs/features/todo/01-telegram-userbot/design.md`              | §10 Flood Control, §5 Configuration (rateLimit section)         |
| Impl Plan | `.aidocs/features/todo/01-telegram-userbot/implementation-plan.md` | TASK-04                                                         |

## Task Dependency Tree

```
TASK-04 (Flood Control) <-- you are here
   |
   +---> TASK-08 (Outbound Adapter) -- acquire() before every send
```

## Description

Implement a `FloodController` using a token bucket algorithm with:

1. **Global bucket** — configurable rate (default 20 ops/sec)
2. **Per-chat buckets** — configurable rate (default 1 msg/sec per chat)
3. **Flood wait handling** — when Telegram returns `FLOOD_WAIT_X`, pause all operations for X seconds
4. **Human jitter** — random delay (50-200ms configurable) to avoid machine-like patterns
5. **Metrics** — track wait counts, flood waits, average delay

This is critical for avoiding account bans from Telegram's anti-spam systems.

**Business value:** Prevents account bans by respecting Telegram rate limits, ensuring the userbot remains operational long-term (Risk mitigation from spec §5).

---

## Context

### Related Files (from codebase research)

| File                                 | Purpose                | Patterns to Follow                      |
| ------------------------------------ | ---------------------- | --------------------------------------- |
| `src/channels/plugins/types.core.ts` | Channel capabilities   | How other channels handle rate limiting |
| `extensions/telegram/`               | Existing bot extension | Bot API rate limiting patterns          |

### Code Dependencies

- None (self-contained utility module)

---

## Goals

1. Token bucket rate limiter with global and per-chat limits
2. `acquire(chatId)` blocks until it's safe to send
3. `reportFloodWait(seconds)` pauses all operations globally
4. Configurable jitter for human-like delay patterns
5. Metrics tracking for monitoring

---

## Acceptance Criteria

**AC-1: Global rate limiting**

- Given: Global rate configured at 20 ops/sec
- When: 25 operations are requested simultaneously
- Then: First 20 proceed immediately, remaining 5 wait ~50ms each

**AC-2: Per-chat rate limiting**

- Given: Per-chat rate configured at 1 msg/sec
- When: 3 messages to the same chat are requested in 100ms
- Then: First proceeds immediately, second waits ~1s, third waits ~2s

**AC-3: Flood wait handling**

- Given: Telegram returned FLOOD_WAIT_30
- When: `reportFloodWait(30)` is called, then `acquire(anyChat)` is called
- Then: `acquire` blocks for remaining flood wait duration

**AC-4: Human jitter**

- Given: Jitter configured as [50, 200]
- When: `acquire(chatId)` completes rate limiting
- Then: Additional random delay between 50-200ms is added

**AC-5: Metrics**

- Given: FloodController has been running
- When: `getMetrics()` is called
- Then: Returns `{ totalAcquires, totalWaits, totalFloodWaits, avgWaitMs }`

**AC-6: Independent chat buckets**

- Given: Per-chat rate of 1/sec
- When: Messages to chat A and chat B are requested simultaneously
- Then: Both proceed immediately (independent buckets)

---

## Dependencies

**Depends on:**

- None (standalone utility)

**Blocks:**

- TASK-08 (Outbound Adapter) — calls `acquire()` before every GramJS send

---

## Files to Change

| Action | File                                                    | Scope                                    |
| ------ | ------------------------------------------------------- | ---------------------------------------- |
| CREATE | `extensions/telegram-userbot/src/flood-control.ts`      | FloodController class with token buckets |
| CREATE | `extensions/telegram-userbot/src/flood-control.test.ts` | Unit tests with fake timers              |

---

## Risks & Mitigations

| Risk                                            | Likelihood | Impact | Mitigation                                            |
| ----------------------------------------------- | ---------- | ------ | ----------------------------------------------------- |
| Token bucket memory leak from many chat buckets | Low        | Low    | LRU eviction for chat buckets (evict after 5min idle) |
| Jitter not random enough                        | Low        | Low    | Use crypto.randomInt for better randomness            |
| Flood wait duration too long blocking all ops   | Low        | Medium | Log flood waits, report via metrics, cap at 15min max |

---

## Out of Scope

- Network-level retry logic (TASK-03 Connection Manager handles reconnects)
- Automatic detection of rate limit patterns (just respond to FLOOD_WAIT)
- Per-operation-type rate limiting (all operations share the same bucket)

---

## Testing

| Type | Description                           | File                                                    |
| ---- | ------------------------------------- | ------------------------------------------------------- |
| Unit | Global bucket: 20 ops/sec throughput  | `extensions/telegram-userbot/src/flood-control.test.ts` |
| Unit | Per-chat bucket: 1 msg/sec per chat   | `extensions/telegram-userbot/src/flood-control.test.ts` |
| Unit | Flood wait pauses all operations      | `extensions/telegram-userbot/src/flood-control.test.ts` |
| Unit | Jitter adds random delay within range | `extensions/telegram-userbot/src/flood-control.test.ts` |
| Unit | Metrics tracking accuracy             | `extensions/telegram-userbot/src/flood-control.test.ts` |
| Unit | Chat bucket independence              | `extensions/telegram-userbot/src/flood-control.test.ts` |

---

## Estimated Context

| Phase          | Tokens | Notes                                     |
| -------------- | ------ | ----------------------------------------- |
| Research       | ~2k    | Token bucket algorithm, existing patterns |
| Implementation | ~8k    | FloodController class                     |
| Testing        | ~5k    | Unit tests with vi.useFakeTimers()        |
| **Total**      | ~15k   | Focused utility module                    |

---

## Subtasks

- [ ] 1.  Implement TokenBucket class with configurable rate and capacity
- [ ] 2.  Create FloodController with global bucket (default 20/sec)
- [ ] 3.  Add per-chat buckets with LRU eviction (Map + cleanup)
- [ ] 4.  Implement `acquire(chatId)` — wait on global + chat bucket + jitter
- [ ] 5.  Implement `reportFloodWait(seconds)` — global pause
- [ ] 6.  Add configurable jitter (default 50-200ms)
- [ ] 7.  Implement `getMetrics()` — counters for monitoring
- [ ] 8.  Write unit tests using `vi.useFakeTimers()` for deterministic timing
