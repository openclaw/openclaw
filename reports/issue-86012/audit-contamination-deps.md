# Audit: Code Dependency Between #94626 (Status Command) and #86012 (LINE Message Loss)

**Date:** 2026-06-19  
**Branch:** `fix/line-86012`  
**Base:** `upstream/main`  
**Auditor:** Subagent depth 1 (dependency analysis)

---

## Verdict: ✅ **No code dependency — safe to split into two independent PRs**

There are **zero** cross-references — no imports, no shared symbols, no protocol coupling — between the two change sets.

---

## 1. #94626 Changes (Status Command)

### Files Modified

| File                                      | Change                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auto-reply/reply/commands-status.ts` | Added 10-second timeout wrapper around `buildStatusText()`                                                                                         |
| `src/status/status-message.runtime.ts`    | **Deleted** — lazy boundary no longer needed                                                                                                       |
| `src/status/status-queue.runtime.ts`      | **Deleted** — lazy boundary no longer needed                                                                                                       |
| `src/status/status-text.test.ts`          | Added `vi` import for vitest                                                                                                                       |
| `src/status/status-text.ts`               | Major refactor: replaced runtime lazy-imports with direct static imports; made runtime loaders defensive (`.catch()`); various safety improvements |

### Import Graph (affected files only)

```
src/status/status-text.ts
  → ../auto-reply/reply/queue/enqueue.js          (NEW static import, was lazy)
  → ../auto-reply/reply/queue/settings-runtime.js  (NEW static import, was lazy)
  → ./status-message.js                            (NEW static import, was lazy)
  → ../agents/harness/selection.js                 (lazy, unchanged direction)
  → ./status-subagents.runtime.js                  (lazy, unchanged)
  → ./status-plugin-health.runtime.js              (lazy, unchanged)
  ↛ No references to extensions/line/ anywhere

src/auto-reply/reply/commands-status.ts
  → src/status/status-text.ts (via buildStatusText, unchanged)
  ↛ No references to extensions/line/ anywhere
```

---

## 2. #86012 Changes (LINE Message Loss)

### Files Modified

| File                                            | Change                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `extensions/line/src/auto-reply-delivery.ts`    | Pass `pushMessagesLine` and `onReplyError` through deps                                                                    |
| `extensions/line/src/monitor.lifecycle.test.ts` | Mock `logLineChannelQuota`                                                                                                 |
| `extensions/line/src/monitor.ts`                | Wrap delivery in loading keepalive; add `logLineChannelQuota` on startup                                                   |
| `extensions/line/src/reply-chunks.test.ts`      | Test `pushMessagesLine` instead of `pushMessageLine`                                                                       |
| `extensions/line/src/reply-chunks.ts`           | Batch push via `pushMessagesLine` (up to 5 per call); add `pushMessagesLine` to deps                                       |
| `extensions/line/src/retry.test.ts`             | **NEW** — retry logic tests                                                                                                |
| `extensions/line/src/retry.ts`                  | **NEW** — exponential backoff retry for LINE API calls                                                                     |
| `extensions/line/src/send.test.ts`              | Retry tests; quota logging tests; push counter tests                                                                       |
| `extensions/line/src/send.ts`                   | `pushMessageLine` uses `pushLineMessages`; added `withRetry`; `logLineChannelQuota`; push counters; `warn` for HTTP errors |

### Import Graph (affected files only)

```
extensions/line/src/auto-reply-delivery.ts
  → ./reply-chunks.js (via sendLineReplyChunks, local)
  ↛ No references to src/status/ or src/auto-reply/*

extensions/line/src/monitor.ts
  → ./auto-reply-delivery.js (local)
  → ./send.js (local)
  ↛ No references to src/status/ or src/auto-reply/*

extensions/line/src/reply-chunks.ts
  ↛ No references to src/status/ or src/auto-reply/*

extensions/line/src/retry.ts
  → openclaw/plugin-sdk/runtime-env (SDK import)
  ↛ No references to src/status/ or src/auto-reply/*

extensions/line/src/send.ts
  → openclaw/plugin-sdk/* (SDK imports)
  → ./retry.js (local)
  ↛ No references to src/status/ or src/auto-reply/*
```

---

## 3. Cross-Reference Check Results

| Direction                                              | Matches | Conclusion                                                                                                                                                     |
| ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/status/` + `src/auto-reply/` → `extensions/line/` | **0**   | No imports or references                                                                                                                                       |
| `extensions/line/` → `src/status/`                     | **0**   | No imports or references                                                                                                                                       |
| `extensions/line/` → `src/auto-reply/` (core)          | **0**   | The `auto-reply` matches in `extensions/line/` are files _named_ `auto-reply-delivery.ts` — they are local to the plugin, not importing from `src/auto-reply/` |

---

## 4. Semantic Coupling Assessment

Beyond import-level coupling, there is also **no semantic coupling**:

- **#94626** is a reliability improvement for the `/status` command: it adds a timeout so a slow `buildStatusText()` doesn't hang the auto-reply system, and it simplifies the runtime-import architecture.
- **#86012** is a LINE plugin fix: it batches push messages, adds retry logic for API failures, adds quota monitoring, and prevents message loss during delivery.
- They operate on **entirely separate abstractions** with no shared types, functions, or protocols.

---

## 5. Recommendation

Split `fix/line-86012` into two independent PRs:

1. **PR A (#94626)** — `src/status/` + `src/auto-reply/reply/commands-status.ts` changes only
2. **PR B (#86012)** — `extensions/line/` changes only

Either can be merged first without impacting the other. No merge conflicts or behavioral changes are expected from the split.
