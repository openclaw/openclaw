# Webchat → External Channel Cross-Delivery

## Background

When a user starts a conversation via an external channel (e.g., Telegram), a session is created with `origin.provider = "telegram"` and `origin.to = "<chat_id>"`. The same session can then be opened in the webchat Control UI.

**The problem:** When a user sends a message via webchat on a session that originated from an external channel, the reply only appears in webchat. The external channel never sees the message or reply, creating a conversation gap. Since they share the same session key, logically they're the same conversation and should stay in sync.

## Root Cause

Two separate issues combine to cause this:

### 1. Origin overwrite

`deriveSessionOrigin()` in `src/config/sessions/metadata.ts` is called during the dispatch pipeline for every inbound message. When webchat sends a message, the `MsgContext` has `Provider: "webchat"`, `Surface: "webchat"`, `OriginatingChannel: "webchat"`. This produces a `SessionOrigin` with `provider: "webchat"`, which `mergeOrigin()` then writes over the existing `provider: "telegram"` (or any external channel).

After this overwrite, the session's origin no longer references the external channel, so even if forwarding logic existed, it wouldn't know where to send.

### 2. No cross-delivery path

The `chat.send` handler in `src/gateway/server-methods/chat.ts` only delivers replies to the webchat client via broadcast. There was no code path to forward messages to the session's originating external channel.

## Fix

### Fix 1: Preserve external origin (`metadata.ts`)

Add an early-return guard at the top of `deriveSessionOrigin()`. When the provider resolves to `INTERNAL_MESSAGE_CHANNEL` ("webchat"), return `undefined` immediately. Since `mergeOrigin(existing, undefined)` preserves the existing origin unchanged, webchat messages no longer overwrite external channel metadata.

```typescript
export function deriveSessionOrigin(ctx: MsgContext): SessionOrigin | undefined {
  const rawProvider =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  if (normalizeMessageChannel(rawProvider) === INTERNAL_MESSAGE_CHANNEL) {
    return undefined; // preserve existing external origin
  }
  // ... rest unchanged
}
```

**Why this is safe:** Webchat-only sessions (those that never had an external origin) have `origin: undefined`. `mergeOrigin(undefined, undefined)` returns `undefined` — no change. Sessions with an external origin keep their external origin intact.

### Fix 2: Forward to external channel (`chat.ts`)

After loading the session entry, check if the session has a routable external origin:

```typescript
const externalOrigin = entry?.origin;
const shouldForwardToOrigin =
  isRoutableChannel(externalOrigin?.provider) &&
  typeof externalOrigin?.to === "string" &&
  externalOrigin.to.length > 0;
```

Then forward in two places:

1. **User message** — before `dispatchInboundMessage`, fire-and-forget the user's message to the external channel with a `[Control UI]` prefix so external participants know the message came from webchat.

2. **Assistant reply** — in the `.then()` callback after the combined reply is assembled, forward the reply to the external channel (no prefix).

Key design decisions:

- `mirror: false` — webchat already handles transcript writing; avoids double-write
- Fire-and-forget (`void` + `.catch`) — doesn't block the webchat response
- Channel-agnostic — uses `routeReply` which works for Telegram, Discord, Slack, etc.
- Placed outside `if (!agentRunStarted)` — forwards for both agent runs and command responses

## Files Changed

| File                                 | Change                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `src/config/sessions/metadata.ts`    | Early-return guard in `deriveSessionOrigin()` for webchat provider          |
| `src/gateway/server-methods/chat.ts` | Forward user message + assistant reply to external channel via `routeReply` |

## Verification

1. `pnpm build` passes (type-check OK)
2. Open a Telegram session in webchat, send a message — both `[Control UI] message` and the assistant reply appear in Telegram
3. Webchat-only sessions (no external origin) are unaffected
