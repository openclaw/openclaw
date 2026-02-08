# Issue #001: Mattermost Threading Not Wired Through Message Tool

**Status:** ✅ Resolved  
**Priority:** Medium  
**Created:** 2026-02-06  
**Resolved:** 2026-02-06  
**Reporter:** Rei

## Summary

The `message` tool's `replyTo` and `threadId` parameters were not being passed through to Mattermost's `root_id` field, causing all messages to appear as top-level posts instead of threaded replies.

## Root Cause Analysis

The threading parameters were correctly handled in the outer layers but got lost in the middle:

### Complete Code Path (before fix)

1. ✅ `message-action-runner.ts` — Reads `replyTo` from params (`handleSendAction`)
2. ❌ `outbound-send-service.ts` — `executeSendAction` passed `params.ctx.params` but didn't extract threading
3. ❌ `message.ts` — `MessageSendParams` type was missing `replyToId`/`threadId` fields
4. ❌ `message.ts` — `sendMessage()` didn't pass threading to `deliverOutboundPayloads()`
5. ✅ `deliver.ts` — `deliverOutboundPayloads` accepts and passes `replyToId` to channel handlers
6. ✅ `channel.ts` (mattermost) — `sendText` passes `replyToId` to `sendMessageMattermost`
7. ✅ `send.ts` (mattermost) — `sendMessageMattermost` passes `replyToId` to `createMattermostPost`
8. ✅ `client.ts` (mattermost) — `createMattermostPost` maps `rootId` → `root_id` in API payload

**Gap:** Steps 2-4 — the threading parameters existed in `params.ctx.params` but were never extracted and passed through the chain.

## Fix Applied

### 1. `src/infra/outbound/message.ts`

Added `replyToId` and `threadId` to `MessageSendParams` type:

```typescript
type MessageSendParams = {
  // ... existing fields
  replyToId?: string | null;
  threadId?: string | number | null;
  // ...
};
```

Added parameters to `deliverOutboundPayloads` call:

```typescript
const results = await deliverOutboundPayloads({
  // ... existing params
  replyToId: params.replyToId,
  threadId: params.threadId,
  // ...
});
```

### 2. `src/infra/outbound/outbound-send-service.ts`

Extract threading parameters from tool context and pass to `sendMessage`:

```typescript
// Extract threading parameters from tool params
const replyToId =
  typeof params.ctx.params.replyTo === "string" ? params.ctx.params.replyTo : undefined;
const threadId =
  typeof params.ctx.params.threadId === "string" || typeof params.ctx.params.threadId === "number"
    ? params.ctx.params.threadId
    : undefined;

const result: MessageSendResult = await sendMessage({
  // ... existing params
  replyToId,
  threadId,
  // ...
});
```

## Testing

To verify the fix:

```bash
# Send a threaded reply via message tool
openclaw message send --channel mattermost --target <channel_id> --replyTo <parent_post_id> --message "This should be threaded"

# Verify via API
curl -H "Authorization: Bearer <token>" "http://localhost:8065/api/v4/posts/<new_post_id>" | jq '.root_id'
# Should return: "<parent_post_id>" (not empty)
```

## Files Modified

- `src/infra/outbound/message.ts` — Added threading params to type and function call
- `src/infra/outbound/outbound-send-service.ts` — Extract and pass threading params

## Acceptance Criteria

- [x] `message(action=send, replyTo=<id>)` creates threaded reply in Mattermost
- [x] `message(action=send, threadId=<id>)` also works as alias
- [x] Existing threading from incoming messages still works (unaffected)
