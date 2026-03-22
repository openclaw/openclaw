# Implementation Plan: Fix Usage Stats Channel Swap

## Story 1: Reproduce the swap with a failing test

**Files:** `src/gateway/server-methods/usage.test.ts` (or new test file)

Write a unit test that:

- Creates two mock session store entries: one with webchat origin, one with telegram origin
- Simulates the channel resolution logic from `usage.ts:610`
- Asserts that `byChannel` aggregation attributes usage to the correct originating channel
- The test should FAIL with the current code, confirming the swap

## Story 2: Fix channel resolution in usage aggregation

**Files:** `src/gateway/server-methods/usage.ts`

Fix the channel resolution at line 610. The fix should prefer `origin.provider` (the originating channel) over `storeEntry.channel` (the delivery/group channel) for usage attribution. Candidate fix:

```typescript
const channel = merged.storeEntry?.origin?.provider ?? merged.storeEntry?.channel;
```

Or use a dedicated helper that resolves the "usage channel" correctly:

- For group sessions: use `storeEntry.channel` (the group's channel is the correct attribution)
- For DM sessions: use `origin.provider`
- Fallback: use `storeEntry.lastChannel`

Ensure the same corrected value flows to both:

- `byChannelMap` aggregation (line 688)
- Per-session `channel` field in the response (line 734)

## Story 3: Verify client-side aggregation consistency

**Files:** `ui/src/ui/views/usage-metrics.ts`

Since the client recalculates aggregates from session data (`buildAggregatesFromSessions`), the fix in Story 2 (correcting `session.channel`) automatically fixes the client side. Verify:

- `channelMap` at line 427-430 uses `session.channel` (which is now correct from the server)
- No additional client-side changes needed unless there's a separate mapping

## Story 4: Add regression tests

**Files:** `src/gateway/server-methods/usage.test.ts`

Add test cases covering:

- DM webchat session → attributed to "webchat"
- DM telegram session → attributed to "telegram"
- Group telegram session → attributed to "telegram"
- Cross-channel session (webchat origin, telegram delivery) → attributed to originating channel
- Session with `storeEntry.channel` set but different from `origin.provider`

## Story 5: Validate end-to-end

Run full test suite and type checks:

- `pnpm test -- src/gateway/server-methods/usage`
- `pnpm tsgo`
- `pnpm check`

Verify the channel breakdown renders correctly in the dashboard UI.
