# Fix Usage Stats Channel Swap (Issue #52436)

## Goal

Fix the /usage dashboard so that per-channel breakdown correctly attributes usage to the originating channel. Currently, webchat and telegram usage statistics appear swapped — webchat shows telegram's numbers and vice versa — while total usage remains correct.

## Root Cause Analysis

The channel resolution in the usage aggregation pipeline at `src/gateway/server-methods/usage.ts:610` uses:

```typescript
const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
```

`storeEntry.channel` is set by `deriveGroupSessionPatch` (in `src/config/sessions/metadata.ts:122-126`) and reflects the **delivery/group channel** rather than the **originating channel**. For sessions that cross channel boundaries (e.g., a webchat-originated session that delivers to telegram, or a main session with `lastChannel` set differently from origin), `storeEntry.channel` can be the wrong value for usage attribution. The `origin.provider` field correctly tracks the originating channel but is only used as a fallback.

The same channel value is used both for:

- Server-side aggregation (`byChannelMap` at line 688-692)
- Per-session `channel` field sent to the client (line 734)
- Client-side recalculation in `ui/src/ui/views/usage-metrics.ts:427-430`

Since the total is correct (all sessions' usage sums up regardless of channel label), but per-channel buckets are inverted, the issue is strictly in channel label assignment.

## Affected Files

### Backend (primary)

- `src/gateway/server-methods/usage.ts` — channel resolution at line 610
- `src/config/sessions/metadata.ts` — `deriveSessionOrigin`, `deriveGroupSessionPatch`

### Frontend (display)

- `ui/src/ui/views/usage-metrics.ts` — client-side channel aggregation (line 427-430)
- `ui/src/ui/views/usage-render-overview.ts` — "Top Channels" rendering (line 443-447)
- `ui/src/ui/views/usage-render-details.ts` — session detail badges (line 69-70)

### Types

- `src/shared/usage-types.ts` — `SessionUsageEntry.channel` type definition
- `src/config/sessions/types.ts` — `SessionEntry.channel`, `SessionEntry.origin`

## Acceptance Criteria

1. Per-channel usage breakdown on `/usage` correctly attributes sessions to their originating channel.
2. Webchat sessions show under "webchat" in the Top Channels insight list.
3. Telegram sessions show under "telegram" in the Top Channels insight list.
4. Total usage numbers remain unchanged.
5. Group sessions still correctly display their channel.
6. Session detail view shows the correct channel badge.
7. CSV export includes the correct channel value per session.
8. Existing tests pass; new tests cover the channel resolution logic.

## Definition of Done

- [ ] Root cause confirmed via test case reproducing the swap
- [ ] Fix applied to channel resolution in usage aggregation
- [ ] Unit test added covering webchat vs telegram channel attribution
- [ ] Existing usage tests pass (`pnpm test -- src/gateway/server-methods/usage`)
- [ ] Type check passes (`pnpm tsgo`)
- [ ] Lint/format passes (`pnpm check`)
- [ ] Manual verification: channel breakdown matches expected attribution
