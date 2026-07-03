---
summary: "Outbound message lifecycle API for channel plugins: adapters, receipts, durable sends, live preview, and reply pipeline helpers"
title: "Channel outbound API"
read_when:
  - You are building or refactoring a messaging channel plugin send path
  - You need durable final reply delivery, receipts, live preview finalization, or receive acknowledgement policy
  - You are migrating from channel-message, channel-message-runtime, or legacy reply dispatch helpers
---

Channel plugins expose outbound message behavior from
`openclaw/plugin-sdk/channel-outbound`. Use
`openclaw/plugin-sdk/channel-inbound` for receive/context/dispatch
orchestration.

Core owns queueing, durability, generic retry policy, hooks, receipts, and
the shared `message` tool. The plugin owns native send/edit/delete calls,
target normalization, platform threading, selected quotes, notification
flags, account state, and platform-specific side effects.

## Adapter

Most plugins define one `message` adapter:

```ts
import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
} from "openclaw/plugin-sdk/channel-outbound";

export const demoMessageAdapter = defineChannelMessageAdapter({
  id: "demo",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId, threadId, signal }) => {
      const sent = await sendDemoMessage({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
        threadId: threadId == null ? undefined : String(threadId),
        signal,
      });

      return {
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "demo", messageId: sent.id, conversationId: to }],
          kind: "text",
          threadId: threadId == null ? undefined : String(threadId),
          replyToId: replyToId ?? undefined,
        }),
      };
    },
  },
});
```

Only declare capabilities the native transport actually preserves. Cover
each declared send, receipt, live-preview, and receive-ack capability with
the contract helpers exported from this subpath.

## Delivery Evidence

A `MessageReceipt` records the result returned by a channel adapter. Concrete
platform message identifiers show that the platform send path accepted the
message; they do not prove that a recipient's device displayed or read it.
Receipts without platform message identifiers are local receipt metadata only.
Channels with read receipts or device-delivery state should track those facts
through a separate channel-specific path.

## Existing outbound adapters

If the channel already has a compatible `outbound` adapter, derive the
message adapter instead of duplicating send code:

```ts
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";

export const messageAdapter = createChannelMessageAdapterFromOutbound({
  id: "demo",
  outbound,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
    },
  },
});
```

## Durable sends

Runtime send helpers also live on `channel-outbound`:

- `sendDurableMessageBatch(...)`
- `withDurableMessageSendContext(...)`
- `deliverInboundReplyWithMessageSendContext(...)`
- draft streaming/progress helpers such as `resolveChannelDraftStreamingChunking(...)`

`sendDurableMessageBatch(...)` returns one explicit outcome:

| Outcome          | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `sent`           | at least one visible platform message was accepted by the platform send path            |
| `suppressed`     | no platform message should be treated as missing                                        |
| `partial_failed` | at least one platform message was accepted before a later payload or side effect failed |
| `failed`         | no platform receipt was produced                                                        |

Use `payloadOutcomes` when a batch mixes sent, suppressed, and failed
payloads. Do not infer hook cancellation from an empty legacy
direct-delivery result.

## Deferred delivery admission

Use `message.durableFinal.admitDeferredDelivery(...)` when a resolved account
cannot safely accept core-managed outbound or deferred delivery. Core calls
this hook synchronously before live outbound work, including paths that skip
queue persistence, and again before replaying a recovered intent. The context
includes `cfg`, `channel`, `to`, `accountId`, and a `phase` of `live` or
`recovery`.

Return `{ status: "allowed" }` to continue. Return
`{ status: "permanent_rejection", reason }` when the delivery must not be
persisted, sent directly, or replayed. A live rejection fails before queue
creation, message hooks, or platform work. A recovery rejection marks the
queued record failed and skips reconciliation and replay. Omitting the hook
means allowed.

The hook is a synchronous admission decision, not a send path. Read only
already-loaded config or runtime state; do not perform network, filesystem, or
other asynchronous I/O. Contract tests should exercise both phases and both
result variants through `ChannelMessageDurableFinalAdapter` from
`openclaw/plugin-sdk/channel-outbound`.

## Durable Inbound Receive

Channels with an at-least-once inbound source (webhooks that redeliver,
polling loops that resume after a crash, gateway restarts) should track
accept/complete state through a `DurableInboundReceiveJournal` instead of a
channel-local dedupe cache or spool:

```ts
import {
  createDurableInboundReceiveJournalFromQueue,
  replayPendingDurableInboundReceives,
} from "openclaw/plugin-sdk/channel-outbound";

const journal = createDurableInboundReceiveJournalFromQueue({
  queue: runtime.state.openChannelIngressQueue({ stateDir: runtime.state.resolveStateDir() }),
  retention: { pendingMaxEntries: 450, completedMaxEntries: 450 },
});

// On each inbound platform event:
const accepted = await journal.accept(stablePlatformEventId, payload);
if (accepted.kind !== "accepted") {
  return; // already pending or completed — do not redeliver
}
try {
  await handleEvent(accepted.record.payload);
  await journal.complete(stablePlatformEventId);
} catch (err) {
  await journal.release(stablePlatformEventId, { lastError: String(err) });
}

// On reconnect/startup, replay whatever never reached a terminal state:
await replayPendingDurableInboundReceives({
  journal,
  maxAttempts: 5,
  process: async (record) => {
    await handleEvent(record.payload);
    await journal.complete(record.id);
  },
  onDeadLetter: (record) => log.warn(`dropping ${record.id} after ${record.attempts} attempts`),
});
```

- `accept(id, payload)` is the idempotency gate: a duplicate platform delivery
  of an id already `pending` or `completed` returns that state instead of a
  fresh `accepted` record, so the same event is never handled twice.
- `complete(id)` / `release(id, { lastError })` are the two terminal-vs-retry
  outcomes for one delivery attempt; `release` bumps `attempts` and puts the
  record back in `pending()`.
- `fail(id, { reason, message? })` dead-letters an id: it stops appearing in
  `pending()` and later `accept()` calls for the same id report a
  non-`accepted` result, so a redelivered dead-lettered event is not
  reprocessed.
- `replayPendingDurableInboundReceives({ journal, maxAttempts, process })`
  bounds reconnect/restart replay: every pass counts the attempt before
  invoking `process`, so a run that stalls or crashes still converges on
  `maxAttempts` instead of redelivering forever, and calls `fail()` once the
  cap is reached. Use it wherever pending records are replayed after a
  reconnect or gateway restart.
- `createDurableInboundReceiveJournal(...)` builds the same facade directly
  from two `PluginStateKeyedStore` instances (pending/completed) instead of a
  `ChannelIngressQueue`, for channels that already have their own stores.

Do not build a channel-local dedupe map, spool file, or bespoke retry-attempt
counter for inbound acceptance — those duplicate this journal's `accept`/
`release`/`fail` semantics and drift from the shared retention/dead-letter
policy. Pair this with a persistent `createClaimableDedupe` (see
`openclaw/plugin-sdk/persistent-dedupe`) when the channel only needs
replay-duplicate suppression rather than full accept/complete/release
tracking of in-flight work.

## Compatibility dispatch

Assemble inbound reply dispatch through `dispatchChannelInboundReply(...)`
from `channel-inbound`. Keep platform delivery in the delivery adapter; use
`channel-outbound` for message adapters, durable sends, receipts, live
preview, and reply pipeline options.
