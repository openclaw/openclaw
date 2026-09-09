---
summary: "Channel runtime status signals plus media and payload shaping: lifecycle status, typing indicators, media source params, and native payload shaping"
read_when:
  - You publish channel account lifecycle status or typing indicators
  - You need account media limits, hosted media stores, or inbound media facts
  - You are shaping native cards, blocks, or grouped media payloads
title: "Channel status and media"
sidebarTitle: "Status and media"
---

Publish channel runtime status, resolve media limits, and shape native
payloads. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Runtime lifecycle status

For channel-authored runtime state, `ChannelAccountSnapshot.lifecycle` is the
successor to `healthState`. Existing plugins may keep publishing `healthState`
during adoption, and core-derived policy writes remain supported. There is no
removal date; removal waits for external channel-plugin adoption.

## Typing indicators

If your channel supports typing indicators outside inbound replies, expose
`heartbeat.sendTyping(...)` on the channel plugin. Core calls it with the
resolved heartbeat delivery target before the heartbeat model run starts and
uses the shared typing keepalive/cleanup lifecycle. Add
`heartbeat.clearTyping(...)` when the platform needs an explicit stop signal.

## Media source params

Resolve account media limits with `resolveChannelMediaMaxBytes(...)` from
`openclaw/plugin-sdk/account-helpers`. Pass the already-merged account's
`mediaMaxMb` through `resolveChannelLimitMb`; the helper applies the agent
default only when the account/channel limit is absent. Its optional byte result
must reach the actual media loader, capped by any transport ceiling. Preserve
the loader's existing default when no limit is configured.

The focused account-helper import keeps setup and account resolution free of
media analysis runtimes. The old `media-runtime` export remains available for
existing external plugins, but new and bundled callers should use the focused import.

If your channel adds message-tool params that carry media sources, expose
those param names through `plugin.actions.describeMessageTool(...).mediaSourceParams`.
Core uses that explicit list for sandbox path normalization and outbound
media-access policy, so plugins do not need shared-core special cases for
provider-specific avatar, attachment, or cover-image params.

Prefer an action-keyed map such as `{ "set-profile": ["avatarUrl", "avatarPath"] }`
so unrelated actions do not inherit another action's media args. A flat array
still works for params intentionally shared across every exposed action.

Channels that must expose a temporary public URL for a platform-side media
fetch can use `createHostedOutboundMediaStore(...)` from
`openclaw/plugin-sdk/outbound-media` with plugin state stores. Keep platform
route parsing and token enforcement in the channel plugin; the shared helper
only owns media loading, expiry metadata, chunk rows, and cleanup.

`prepareUrl({ mediaAccess })` forwards host-authorized local media access to
the shared outbound loader. Hosted media capacity defaults to
`overflowPolicy: "evict-oldest"` for compatibility. Use `"reject-new"` when
issued URLs must remain valid until expiry, and configure both backing keyed
stores with `"reject-new"` so independent writers cannot evict live rows.
Use `validateBeforePersist` to inspect the guarded loader's exact bytes and
metadata when a transport must reject a payload class. Treat its buffer as
read-only and throw to reject before capability creation or any store write.
Authenticate bearer requests with `readMetadata(...)` before calling `read(...)`
so invalid tokens and `HEAD` requests do not hydrate stored media chunks.

Inbound attachments use ordered facts, not parallel `Media*` fields. Normalize
channel records with `toInboundMediaFacts(...)` from
`openclaw/plugin-sdk/channel-inbound` and pass them as `media` when building the
inbound context. When a plugin must authorize local media reads, import
`getAgentScopedMediaLocalRoots(...)` or
`getAgentScopedMediaLocalRootsForSources(...)` from the focused
`openclaw/plugin-sdk/media-local-roots` subpath. The old
`agent-media-payload` builder/root facade is deprecated compatibility.

## Native payload shaping

Set `outbound.sendPayloadGroupsMedia: true` only when the payload sender owns
multi-attachment grouping. Core then preserves a multi-media list for that
sender when its durable payload and reconciliation capabilities permit it.
Without this explicit opt-in, ordinary attachments keep per-item delivery.

Grouped senders must check the outbound context's `signal` before each physical
send and after awaited preparation, and retain the platform-dispatch and
current-owner callbacks at each send boundary. Declaring general payload
support alone does not opt a plugin into this responsibility.

If your channel needs provider-specific shaping for `message(action="send")`,
prefer `actions.prepareSendPayload(...)`. Put native cards, blocks, embeds, or
other durable data under `payload.channelData.<channel>` and let core send
through the outbound/message adapter. Use `actions.handleAction(...)` for send
only as a compatibility fallback for payloads that cannot be serialized and
retried.

For send actions, preserve the trusted context's `onPlatformSendDispatch`,
`assertDirectAdapterHandoff`, and `skipQueue` when calling
`sendDurableMessageBatch(...)`. These fields come from the host, not action
arguments. Await the dispatch callback before each physical send, then call
the synchronous assertion after preparation or throttling waits and immediately
before platform I/O. A closed owner must stop every remaining send.

`skipQueue: true` keeps sends tied to a live run out of replayable recovery.
The separate `deliveryRetryOwner` field controls who handles failed delivery;
it does not extend the run's authority. Operator sends retain normal durable
queueing. Do not serialize either authority callback or expose these fields in
the model-facing action schema.
