---
summary: "The channel message adapter surface: live and finalizer capabilities, progress visibility, commentary delivery, and native TTS voice delivery"
read_when:
  - You are declaring `message` adapter capabilities for a channel
  - You need progress, quiet-progress, or commentary delivery rules
  - You are wiring native voice-note delivery for a channel
title: "Channel message adapter"
sidebarTitle: "Message adapter"
---

Declare and wire the `message` adapter that core uses to send through your
channel. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Message adapter

Expose a `message` adapter with `defineChannelMessageAdapter` from
`openclaw/plugin-sdk/channel-outbound`. Declare only the durable final-send
capabilities your native transport actually supports, backed by a contract
test that proves the native side effect and returned receipt. Point text/media
sends at the same transport functions the legacy `outbound` adapter uses. For
the full API contract, capability matrix, receipt rules, live preview
finalization, receive ack policy, tests, and migration table, see
[Channel outbound API](/plugins/sdk-channel-outbound).

If your existing `outbound` adapter already has the right send methods and
capability metadata, derive the `message` adapter with
`createChannelMessageAdapterFromOutbound(...)` instead of hand-writing another
bridge. Adapter sends return `MessageReceipt` values. For legacy ids, derive
them with `listMessageReceiptPlatformIds(...)` or
`resolveMessageReceiptPrimaryId(...)` instead of keeping parallel `messageIds`
fields.

For turn adapters that aggregate confirmed visible sends, use
`createAcceptedChannelDeliveryResult(...)` from
`openclaw/plugin-sdk/channel-inbound`. It combines native `results` followed by
logical `deliveryResults`, including a partial-delivery error's accepted subset.
A logical result's receipt takes precedence over its legacy message IDs.
The result carries a receipt, `messageIds` (including an empty array), and
`visibleReplySent: true`; routing fields stay in the receipt. Optional `content`
is passed through, and `kind` and `replyToId` use the receipt builder's rules.
Keep acceptance side effects, content joining,
suppression, and whether an identityless outcome needs a receipt in the adapter.

Channel actions and adapter capabilities come from the selected plugin
registration. An omitted `actions`, `message`, or `outbound` surface is not
filled from another plugin with the same channel ID. Prepared delivery handlers
created inside a registry scope retain that handle when invoked after the caller
leaves the scope.

Declare live and finalizer capabilities precisely - core uses these to decide
what a channel can do, and drift between the declared and actual behavior is a
contract test failure:

| Surface                               | Values                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `message.live.capabilities`           | `draftPreview`, `previewFinalization`, `progressUpdates`, `nativeStreaming`, `quietFinalization` |
| `message.live.finalizer.capabilities` | `finalEdit`, `normalFallback`, `discardPending`, `previewReceipt`, `retainOnAmbiguousFailure`    |

Channels that finalize a draft preview in place should route the runtime logic
through `defineFinalizableLivePreviewAdapter(...)` plus
`deliverWithFinalizableLivePreviewAdapter(...)`, and keep the declared
capabilities backed by `verifyChannelMessageLiveCapabilityAdapterProofs(...)`
and `verifyChannelMessageLiveFinalizerProofs(...)` tests so native preview,
progress, edit, fallback/retention, cleanup, and receipt behavior cannot drift
silently.

### Progress visibility acceptance

Progress callbacks report what the operator can see, not merely what a plugin queued. Return
`true` after accepting visible progress and `false` while delivery is pending or when no visible
update occurred. Existing synchronous and asynchronous callbacks that return `void` remain
backward-compatible and are treated as visible; new acceptance-aware implementations should use
an explicit boolean.

### Quiet progress presentation

Native progress renderers must retain approval and failure lines when ordinary
tool rows are disabled. The shared progress compositor retains those lines in
its snapshots; native renderers must preserve them alongside plan rows and
ordinary activity.

`resolveChannelStreamingPreviewToolProgress(entry, defaultValue?, mode?)` keeps
its shipped default of `true` when the second argument is omitted or
`undefined`. Bundled channels pass `mode !== "progress"` as the second argument
and their resolved streaming mode as the third argument, so unconfigured
`progress` drafts hide ordinary tool rows while `partial` and `block` previews
show them.

The compositor and formatter's `presentation: "summary"` option and the
checklist formatter's `plain: true` option are deprecated but retain their
explicit output until the next breaking SDK release. New callers should omit
them and use `streaming.progress.toolProgress` to control tool rows with the
standard progress markers.

### Quiet acknowledgement and coalesced progress

`createStatusReactionController({ presentation: "acknowledgement", ... })`
keeps the initial reaction through work and success, skips inactivity warnings,
and retains the existing error/cleanup lifecycle. The default `activity` policy
continues to expose detailed lifecycle reactions.

For edited or native progress, `createDraftStreamLoop` and finalizable draft
controls accept `coalesceInFlight: true` to keep background updates arriving
during a send in the next throttle window. Explicit `flush()` still bypasses
the delay for attention and finalization. Cancel pending updates and await
in-flight work before closing or rotating a stream.

### Commentary delivery ownership

Set `commentaryPayloadsEnabled: true` when the channel supports durable commentary messages.
Channels that normally render commentary in one evolving progress draft can also provide
`shouldDeliverCommentaryPayloads`. Core freezes verbose visibility for the turn, registers that
getter through `onVerboseProgressVisibility`, evaluates the delivery callback once before
dispatch, and snapshots that result for the whole turn. Session changes apply on the next turn.
The callback is inert unless `commentaryPayloadsEnabled` is also `true`; without that static
opt-in, core neither evaluates the callback nor freezes the registered visibility getter.

Return `false` while the draft owns normal progress and `true` when verbose progress makes that
draft yield to durable commentary. Keep the callback synchronous and read only channel-owned,
already prepared state. Omitting it preserves durable delivery for existing plugins that use the
static opt-in. The callback does not control reasoning, partial replies, tool progress, or final
answers.

Inbound receivers that defer platform acknowledgements should declare
`message.receive.defaultAckPolicy` and `supportedAckPolicies` instead of hiding
ack timing in monitor-local state. Cover every declared policy with
`verifyChannelMessageReceiveAckPolicyAdapterProofs(...)`.

### TTS voice delivery

Declare native voice-note behavior under `capabilities.tts.voice`. Set
`synthesisTarget: "voice-note"` when TTS providers should produce a native
voice-note format. Set `captionedFinalText: true` only when the outbound voice
operation accepts visible final text and enforces its transport's caption and
overflow rules. Core then holds final-mode streamed text for that operation and
falls back to text when the voice payload is proven unsent.

The legacy `dispatchInboundReplyWithBase` helper remains available from the
deprecated `openclaw/plugin-sdk/inbound-reply-dispatch` compatibility shim.
Do not use it for new channel code; start with the `message` adapter, receipts,
and receive/send lifecycle helpers on `openclaw/plugin-sdk/channel-outbound`
instead.
