---
summary: "Claim inbound messages and rewrite or cancel outbound deliveries"
read_when:
  - You are claiming an inbound message before the normal model dispatch
  - You are taking over reply generation with reply_dispatch
  - You need to rewrite or cancel an outbound message or reply payload
title: "Message and delivery hooks"
sidebarTitle: "Messages"
---

Inbound interception, reply takeover, and outbound delivery policy. Part of the [Plugin hooks](/plugins/hooks) guide.

## Message hooks

For inbound interception, `before_dispatch` receives the incoming message
before ordinary model dispatch. Return `{ handled: true, text: "..." }` to
send a final reply, or `{ handled: true }` to handle it without text. This is a
claim, not an API for rewriting outbound or inbound content.

`reply_dispatch` is the advanced takeover seam: it receives the finalized
message context and a host dispatcher, and a handled result reports
`queuedFinal` and delivery `counts`. Use `before_agent_reply` for a simple
synthetic reply, and the sending hooks below to transform outgoing payloads.

Runtime takeovers should forward `ctx.onAgentRunStart`,
`ctx.userTurnTranscriptRecorder`, and optional
`ctx.prepareAssistantTranscriptMessage` to their runtime helper. The ACP dispatch
helper forwards all three automatically. Share the recorder so the runtime and
Gateway do not append the same user turn independently; mark runtime
persistence only after a successful transcript write.

The host-provided preparer records display ownership before the canonical
assistant append, using original runtime text captured before transcript-only
hooks. It preserves raw content and IDs and grants no file access or write
authority. Keep it in process and bound to its owning turn; after that turn
aborts, is replaced, or completes, it returns the message unchanged.

The optional third `onAgentRunStart` argument can offer
`completionSource: "reply-dispatch"` with a `getResult()` callback. The host must
return `"reply-dispatch"` synchronously to accept completion ownership; observers
and other callback results leave lifecycle completion unchanged. Wrappers must
forward every callback argument and its return value. After dispatch settles,
`getResult()` supplies the canonical `terminalOutcome` and, when an
assistant write succeeded, its `assistantTranscript` receipt (target, message
ID, idempotency key, and optional projection anchor). The host then emits one
chat completion from the delivered, post-hook payloads while retaining runtime
lifecycle events. A receipt prevents a duplicate append; it does not authorize
writes to a replaced session. Omit this declaration for runtimes whose event
stream already owns chat completion.

Use `eligibleDispatchKinds: ["acp"]` for an ACP-only dispatcher. The host
classifies the resolved target, including conversation bindings, and passes
`ctx.dispatchKind` as `acp` or `agent`. Stored ACP metadata and ACP session keys
both select `acp`; a missing ACP binding does not fall back to agent dispatch.
The host applies the same eligibility check before invocation and when deciding
whether a hook prevents durable chat admission. An ACP-only hook therefore
does not block ordinary agent sessions. Omitted, empty, malformed, or partly
unknown eligibility lists remain unrestricted. Missing or unknown dispatch
context also keeps the hook eligible.

Use message hooks for channel-level routing and delivery policy:

- `message_received`: observe inbound content, sender, `threadId`,
  `messageId`, `senderId`, optional run/session correlation, ordered `media`,
  normalized `location`, stable `providerUpdate` identity when supplied by the
  channel, and metadata.
- `message_sending`: rewrite `content` or return `{ cancel: true }`.
- `reply_payload_sending`: rewrite normalized `ReplyPayload` objects
  (including `presentation`, `delivery`, media refs, and text) or return
  `{ cancel: true }`.
- `message_sent`: observe final success or failure.

For audio-only TTS replies, `content` may contain the hidden spoken
transcript even when the channel payload has no visible text/caption.
Rewriting that `content` updates the hook-visible transcript only; it is not
rendered as a media caption.

`reply_payload_sending` events may include `usageState`, a best-effort live
per-turn model/usage/context snapshot. Durable delivery, recovered replay, and
replies without exact run correlation omit it.

Message hook contexts expose stable correlation fields when available:
`ctx.sessionKey`, `ctx.runId`, `ctx.messageId`, `ctx.senderId`, `ctx.trace`,
`ctx.traceId`, `ctx.spanId`, `ctx.parentSpanId`, and `ctx.callDepth`. Inbound
and `before_dispatch` contexts also expose reply metadata when the channel
has visibility-filtered quoted message data: `replyToId`, `replyToIdFull`,
`replyToBody`, `replyToSender`, and `replyToIsQuote`. Prefer these
first-class fields before reading legacy metadata.

`before_dispatch` receives the canonical inbound `messageId` in both its event
and context.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata.

Inbound claim and message-received events expose `media?:
PluginHookMediaFact[]` as the canonical attachment API. Each fact can carry
`path`, `url`, `contentType`, `kind`, `transcribed`, `messageId`, and
`workspaceDir`; array position is attachment identity. When a remote attachment
has not been staged locally yet, `media` is omitted,
`mediaStagingPending: true`, and `originalMedia` contains the provider-side
facts. Do not treat `originalMedia.path` as locally readable until a later
staged event supplies `media`.

The singular/plural `mediaPath`, `mediaUrl`, `mediaType`, `mediaPaths`,
`mediaUrls`, `mediaTypes`, and matching `originalMedia*` metadata properties are
deprecated compatibility aliases. New hooks should use the typed top-level
arrays.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- Each `message_sending` handler receives the original event content. The last
  returned `content` wins; a later handler can still cancel delivery.
- `reply_payload_sending` runs after payload normalization and before channel
  delivery, including replies routed back to the originating channel.
  Handlers run sequentially and each handler sees the latest payload produced
  by higher-priority handlers.
- `reply_payload_sending` payloads do not expose runtime trust markers such as
  `trustedLocalMedia`; plugins can edit payload shape but cannot grant local
  media trust.
- `message_sending` can return `cancelReason` and bounded `metadata` with a
  cancellation. New message lifecycle APIs expose this as a suppressed
  delivery outcome with reason `cancelled_by_message_sending_hook`; legacy
  direct delivery keeps returning an empty result array for compatibility.
- `message_sent` is observation-only. Handler failures are logged and do not
  change the delivery result.
