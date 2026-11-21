---
title: "Bounded held history window"
summary: "Design for keeping Control UI chat cost and memory constant while a reader pages deep into a long session"
read_when:
  - Changing how the Control UI pages, holds, or evicts chat history
  - Evaluating older-page cost in long sessions
---

# Bounded held history window

Status: proposed. Not implemented. Product decisions are listed under
[Decisions needed](#decisions-needed).

## Problem

A reader who scrolls back through a long conversation keeps every row loaded so
far. Each older page replaces `state.chatMessages` with a longer array, and the
pipeline after it walks every held row again:

1. `prependUniqueNativeMessages` (`ui/src/lib/chat/history-message-identity.ts`):
   two identity passes over held rows.
2. `publishChatSessionProjectionMessages` (`ui/src/pages/chat/history-merge.ts`):
   superseded-row sets, the accepted-order loop, the occurrence map, and
   `createSessionProjection` with `readSessionMessageIdentity` for every row.
3. `publishChatSessionProjection`: element-wise comparison and array copy.
4. `commitCurrentChatHistorySnapshot`: row display and the 12 MiB snapshot bound.
5. `buildCachedChatItems` / `buildChatItems` (`chat-thread.ts`, `chat-thread-build.ts`):
   heartbeat/commentary filter, normalization, message items, canvas turns, main
   loop, tool coalescing, `sessions_yield` scan, input placement, question history.
6. `projectTranscriptChain` / `projectTranscriptIndex` / `projectTranscriptRows`.

The Gateway side is flat: `chat.history` takes 35 to 75 ms per page at any depth.
Browser cost grows linearly. Against a real isolated Gateway and the production
bundle (30,000 messages, 1,000-message pages), unthrottled script time per older
page was about 150 ms at pages 1 to 5 and about 305 ms at pages 21 to 25 (4x CPU
throttle: about 650 ms and 1,350 ms).

The pure stages scale the same way in isolation. Each row below is the median
of three runs of one 1,000-row older page prepended to `held` rows on a loaded
shared host (load average about 17):

| held   | prepend | projection | `buildChatItems` | chain + index |
| ------ | ------- | ---------- | ---------------- | ------------- |
| 1,000  | 0.3 ms  | 0.3 ms     | 8.7 ms           | 9.5 ms        |
| 4,000  | 0.8 ms  | 0.6 ms     | 21.1 ms          | 28.6 ms       |
| 8,000  | 1.2 ms  | 0.9 ms     | 37.9 ms          | 49.5 ms       |
| 12,000 | 1.8 ms  | 1.3 ms     | 59.1 ms          | 52.8 ms       |
| 16,000 | 2.7 ms  | 1.5 ms     | 81.5 ms          | 75.6 ms       |

Incremental rendering can lower the constant factor. Only a bounded window holds
per-page work and memory constant at any depth. The snapshot cache is already
capped at 12 MiB (`MAX_CACHED_CHAT_SNAPSHOT_WEIGHT`); the live pane is not.

## Constraints from existing owners

Every live writer assumes that the held array ends at the live tail:

- `insertSessionProjectionEntry` (`packages/gateway-client/src/session-projection-order.ts`)
  places a persisted live message before the first held row with a larger
  sequence. If no held row has a larger sequence, the message goes last. With an
  evicted tail it would sit directly after the deep rows.
- Delta-cursor reads (`chat-history-stream.ts`), send/steer pending rows
  (`chat-send-delivery.runtime.ts`), run lifecycle, stream segments, and queued
  input placement (`chat-thread-inputs.ts`) all append at the tail.
- End-follow and **Scroll to latest** (`scroll.ts`, `chatReadingHistory`) scroll
  to the end of the held rows.
- `reconcileHistoryTail` and `fillHeldHistoryGap` merge a fresh tail into the
  held prefix by source identity.
- The snapshot cache and the `chat-history-state.ts` read model report held
  rows as the session's recent history.

The Gateway already pages in both directions. Anchored pages
(`chat-history-page-kernel.ts`, `transcript-anchor-page.ts`) return `olderCursor`
and `newerCursor`. A newer page excludes the anchor's sequence group, and
`chat-history-page-cursor.test.ts` covers reversing an older page with its
`newerCursor`. A `messageId` + `sessionId` probe with `limit: 1` returns the
cursors for any held row with neighbors; the UI already uses this probe to reopen a trimmed
older edge (`needsBoundary`). Today the UI reads only `olderCursor`.

## Options

### Detached tail (rejected for now)

Evict the newest rows once the reader is far from the tail and reload them on the
way back. The window no longer reaches the live tail, so every writer above
needs a detached mode. Without one, live rows join the deep rows, pending
inputs and streams render after the wrong row, and **Scroll to latest** lands
on stale history. That means changes in the projection reducer, delta reads,
send delivery, input placement, end-follow, and the cache: several competing
guards for one fact.

### Split window: deep block, gap, live tail (proposed)

Hold two contiguous runs of server rows: the **deep block** around the reader and
the **tail block** ending at the live tail. Between them is at most one **gap**.
The array stays sequence-ordered and still ends at the live tail, so live
appends, pending and queued rows, streams, end-follow, **Scroll to latest**, delta
reads, and tail reconciliation keep their current behavior.

## Design

### Ownership

- **Window:** `state.chatMessages` remains the only held array and is still
  published only through `history-merge.ts`. `ChatHistoryPagination`
  (`chat-history-pagination.ts`) already owns the older edge and gains one
  optional fact: `gap: { afterSource, beforeSource, newerCursor? }`.
  `afterSource` is the newest deep-block row and `beforeSource` the oldest
  tail-block row, both native source identities. Every writer that replaces
  pagination either keeps the gap with its rows (`reconcileHistoryTail` spreads
  the previous pagination) or replaces both.
- **Eviction decision:** `ChatPaneHistory` already owns older paging. It calls
  one pure function that returns the bounded `{ messages, pagination }`.
  Request and render code never evicts.
- **Rendering:** `buildChatItems` receives `gap.afterSource` and emits one
  `history-gap` boundary item. Grouping, tool coalescing, the `sessions_yield`
  scan, canvas-turn matching, and reasoning attachment never join rows
  across it.
- **Cache:** with a gap, `commitCurrentChatHistorySnapshot` caches only the tail
  block, using `trimmedChatHistoryPagination` (`needsBoundary`). The persisted
  record schema stays the same. A restored session shows the tail; the deep
  reading position is not restored (accepted).

### Eviction policy

- Trigger only after an older-page prepend, when the reader is moving away from
  the tail, and only when held rows exceed `K_max` (proposed 5,000 rows or the
  12 MiB snapshot weight, whichever comes first). Trim to `K_target` (proposed
  4,000).
- Keep the deep block: the newly prepended page through the rows past the
  viewport plus a margin (proposed two pages). Keep the tail block: the
  latest-page rows (`CHAT_HISTORY_REQUEST_LIMIT`) plus any pending, queued, or
  live-run rows. Evict only between the two blocks.
- Cut only where a sequence group ends (as `boundChatSessionSnapshot` does) and a
  user row starts the next turn, so tool calls, tool results,
  reasoning, and handoffs are never split.
- Evicted rows are below the viewport. The virtualizer measures from the top,
  so no anchor correction is needed.
- Do not evict while search is open, during reply navigation, or while a
  catalog session is shown (catalog sessions page through their own cursor).

### Reloading newer rows

- The gap row has a sentinel. When the reader scrolls down into it, an
  IntersectionObserver (the mirror of the older sentinel, with the same
  intent, settle, and failure gates) loads newer rows. The row also has an
  explicit **Load newer messages** action.
- Request: `chat.history { cursor: gap.newerCursor, limit: 1000, maxBytes }`.
  Without a cursor, probe `afterSource` as the older edge does today.
- Apply: insert unique rows after `afterSource`. If the page reaches
  `beforeSource` or returns no `newerCursor`, remove the gap and merge the
  overlap by source identity. `windowReset` or a session change falls back to
  `reloadChatHistoryWindow`, as older paging does.
- While filling downward, trim the oldest deep rows and set the older edge to
  `needsBoundary`. Those rows are above the viewport, so this step needs
  `TranscriptPrependAnchor` to treat a removed leading run like a prepend
  (capture the visible anchor, then restore its offset). That generalization
  belongs to a later stage.

### Scroll to latest and live events

- **Scroll to latest** is unchanged because the tail block is held. Reaching the
  tail with a gap above it may drop the deep block and the gap (older edge
  `needsBoundary` at the tail block's start), returning the pane to today's
  single-block state.
- Live appends while the reader is deep go to the tail block by sequence, as
  now. The new-messages indicator works as before. A very long live run while
  the reader stays deep can grow the tail block beyond its share. Accept that
  until the next eviction trigger, which can move `beforeSource` forward.

### Reply navigation

`openReplyMessage` loads older pages until the target is held. With a gap, a
target whose sequence falls between `afterSource` and `beforeSource` must fill
the gap instead. A target older than the deep block keeps the current loop.
Targets without sequence data fall back to older paging. A centered
`messageId` jump window is a separate later mode.

## Stages

1. Gap fact in `ChatHistoryPagination`, eviction after older prepend,
   `history-gap` boundary item with **Load newer messages**, newer fill without
   top trimming, tail-only cache commits, and the no-evict conditions above.
   Regression tests: per-page work stays flat at fixed `K` (work count over
   `buildChatItems` and projection inputs), live appends during a gap land
   after the tail, and closing the gap restores grouping across the seam.
2. Sentinel-driven newer fill and top trimming with leading-removal anchor
   correction.
3. Reply navigation into the gap and the **Scroll to latest** shrink.

Each stage needs Control UI e2e proof against an isolated Gateway with a long
session, plus before/after screenshots for the gap row.

## Decisions needed

1. **Loaded rows may leave the client.** Search filters held rows only, and
   browser find and reply previews see held rows only. Choose: pause
   eviction while search is open (proposed for stage 1), show a hint that
   matches in unloaded history are hidden, or add server-side transcript search.
2. **Gap affordance.** A visible **Load newer messages** divider in the middle of
   the transcript, or invisible auto-fill only. This is a visual change.
3. **Bound.** `K_max`/`K_target` in rows and weight (proposed 5,000/4,000 rows,
   capped by the existing 12 MiB snapshot weight).
4. **Sequencing with render work.** Incremental item building and projection
   lower the per-row constant. Decide whether the bound ships after that work or
   alongside it, since the remaining linear memory and per-page cost only matter
   past several thousand rows.
