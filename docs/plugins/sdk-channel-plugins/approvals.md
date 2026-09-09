---
summary: "Approval capabilities for channel plugins: approval auth, payload lifecycle and setup guidance, native approval delivery, and the narrower approval runtime subpaths"
read_when:
  - Your channel exposes native exec or plugin approvals
  - You need approval auth, setup guidance, or reaction-based decisions
  - You want the narrow approval runtime subpaths instead of the barrel
title: "Channel approvals"
sidebarTitle: "Approvals"
---

Most channel plugins do not need approval-specific code. Reach for this page
when yours does. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Approvals and channel capabilities

Most channel plugins do not need approval-specific code. Core owns same-chat
`/approve`, shared approval button payloads, and generic fallback delivery.
`ChannelPlugin.approvals` was removed; put approval delivery/native/render/auth
facts on one `approvalCapability` object instead. `plugin.auth` is login/logout
only - core no longer reads approval auth hooks from that object.

Use `approvalCapability.delivery` only for native approval routing or fallback
suppression, and `approvalCapability.render` only when a channel truly needs
custom approval payloads instead of the shared renderer.

### Approval auth

- `approvalCapability.authorizeActorAction` and
  `approvalCapability.getActionAvailabilityState` are the canonical
  approval-auth seam.
- Use `getActionAvailabilityState` for same-chat approval auth availability.
  Keep configured approvers available for `/approve` even when native delivery
  is disabled; use native initiating-surface state for delivery/setup guidance
  instead.
- If your channel exposes native exec approvals, use
  `approvalCapability.getExecInitiatingSurfaceState` for the
  initiating-surface/native-client state when it differs from same-chat
  approval auth. Core uses that exec-specific hook to distinguish `enabled` vs
  `disabled`, decide whether the initiating channel supports native exec
  approvals, and include the channel in native-client fallback guidance.
  `createApproverRestrictedNativeApprovalCapability(...)` fills this in for
  the common case.
- If a channel can infer stable owner-like DM identities from existing config,
  use `createResolvedApproverActionAuthAdapter` from
  `openclaw/plugin-sdk/approval-runtime` to restrict same-chat `/approve`
  without adding approval-specific core logic.
- If custom approval auth intentionally allows only same-chat fallback, return
  `markImplicitSameChatApprovalAuthorization({ authorized: true })` from
  `openclaw/plugin-sdk/approval-auth-runtime`; otherwise core treats the
  result as explicit approver authorization.
- If a channel-owned native callback resolves approvals directly, use
  `isImplicitSameChatApprovalAuthorization(...)` before resolving so implicit
  fallback still goes through the channel's normal actor authorization.

### Payload lifecycle and setup guidance

- Use `outbound.shouldSuppressLocalPayloadPrompt` or
  `outbound.beforeDeliverPayload` for channel-specific payload lifecycle
  behavior such as hiding duplicate local approval prompts or sending typing
  indicators before delivery.
- Use `approvalCapability.describeExecApprovalSetup` when the channel wants
  the disabled-path reply to explain the exact config knobs needed to enable
  native exec approvals. The hook receives `{ channel, channelLabel, accountId }`;
  named-account channels should render account-scoped paths such as
  `channels.<channel>.accounts.<id>.execApprovals.*` instead of top-level
  defaults.
- Use `approvalCapability.describePluginApprovalSetup` when plugin approval
  failure guidance is safe to show for plugin approval no-route and timeout
  failures. `createApproverRestrictedNativeApprovalCapability(...)` does not
  infer this from `describeExecApprovalSetup`; pass the same helper explicitly
  only when plugin and exec approvals truly use the same native setup.

### Native approval delivery

If a channel needs native approval delivery, keep channel code focused on
target normalization plus transport/presentation facts. Use
`createChannelExecApprovalProfile`, `createChannelNativeOriginTargetResolver`,
`createChannelApproverDmTargetResolver`, and
`createApproverRestrictedNativeApprovalCapability` from
`openclaw/plugin-sdk/approval-runtime`. Put the channel-specific facts behind
`approvalCapability.nativeRuntime`, ideally via
`createChannelApprovalNativeRuntimeAdapter(...)` or
`createLazyChannelApprovalNativeRuntimeAdapter(...)`, so core can assemble the
handler and own request filtering, routing, dedupe, expiry, gateway
subscription, and routed-elsewhere notices.

`nativeRuntime` is split into a few smaller seams:

- `availability` - whether the account is configured and whether a request
  should be handled
- `presentation` - map the shared approval view model into
  pending/resolved/expired native payloads or final actions
- `transport` - prepare targets plus send/update/delete native approval
  messages
- `interactions` - optional bind/unbind/clear-action hooks for native buttons
  or reactions, plus an optional `cancelDelivered` hook. Implement
  `cancelDelivered` when `deliverPending` registers in-process or persistent
  state (such as a reaction target store) so that state can be released if a
  handler stop cancels the delivery before `bindPending` runs, or when
  `bindPending` returns no handle
- `observe` - optional delivery diagnostics hooks

Native approval runtimes can receive three approval kinds: `exec`, `plugin`,
and `system-agent`. A `system-agent` request asks an operator to approve a
Gateway-side persistent change, such as a config write or Gateway restart.
The runtime must render the typed approval actions and then render the final
application result. An allowed request can finish as applied or not applied;
do not treat the recorded approval alone as proof that the change completed.

Other approval helpers:

- Use `settleApprovalReaction` from
  `openclaw/plugin-sdk/approval-reaction-runtime` for explicitly authorized
  reaction decisions. It checks the supplied approvers and actor authorization,
  loads the Gateway resolver lazily, and calls `clearTarget` for every terminal
  result (including a losing click) or approval-not-found error. Keep transport
  identity, route checks, cleanup, and result logging in the plugin. Other errors
  propagate with the binding intact; the channel must hand them to its durable
  ingress or poller for replay. `readApprovalReactionTargetRecord` validates the
  shared persisted fields; transport-specific route and author fields still need
  their own validation.
- Use `formatChannelApprovalResolvedLabel` and
  `buildSystemAgentApprovalResolvedText` from
  `openclaw/plugin-sdk/approval-runtime` for terminal presentation.
  Rich labels preserve application-status precedence; prose preserves denial
  precedence, because a denied system change can also report `not-applied`.
  Both prioritize cancellation. Pass a decision formatter for transport-specific
  label spelling, and prepare any bounded operation summary before building prose.
  Use `formatApprovalDecisionLabel` for a recorded decision without implying
  application completion.
- Approval account lookup helpers `resolveApprovalRequestAccountId` and
  `resolveApprovalRequestChannelAccountId` use `approval-native-runtime`. Their
  duplicate `approval-runtime` exports and its unused
  `matchesApprovalRequestSessionFilter` export have been retired. The core
  implementations are unchanged.
- Use `createNativeApprovalControlRegistry` from
  `openclaw/plugin-sdk/approval-runtime` for process-local native card
  tokens. Each instance owns a 1,024-binding FIFO registry and holds its claim
  through Gateway resolution and the terminal card update. Missing approvals
  retire their tokens; other failures release the claim for retry. Plugins
  validate native event scope and authorize the actor before calling `settle`,
  retain their lookup-expiry policy through `releaseClaimOnLookupExpiry`, and
  use `onComplete` for transport-owned cleanup such as manual-prompt suppression.
- Use `createNativeApprovalChannelRouteGates` from
  `openclaw/plugin-sdk/approval-native-runtime` when a channel supports both
  session-origin native delivery and explicit approval forwarding targets. The
  helper centralizes approval config selection, `mode` handling, agent/session
  filters, account binding, session-target matching, and target-list matching
  while callers still own the channel id, default forwarding mode, account
  lookup, transport-enabled check, target normalization, and turn-source
  target resolution. Do not use it to create core-owned channel policy
  defaults; pass the channel's documented default mode explicitly.
  The unused `createChannelApprovalForwardingEvaluator` export has been retired;
  this route-gate helper remains the supported routing path.
- `createNativeApprovalMessagingTargetResolvers` centralizes channel matching
  and `{ to, accountId, threadId }` normalization for messaging transports
  whose native approval target is a channel-owned normalized destination.
  Keep group authorization, approver mapping, and other transport policy in
  the channel plugin.
- `createChannelNativeOriginTargetResolver` uses the shared channel-route
  matcher by default for `{ to, accountId, threadId }` targets. Pass
  `targetsMatch` only when a channel has provider-specific equivalence rules,
  such as Slack timestamp prefix matching. Pass `normalizeTargetForMatch` when
  the channel needs to canonicalize provider ids before the default route
  matcher or a custom `targetsMatch` callback runs, while preserving the
  original target for delivery. Use `normalizeTarget` only when the resolved
  delivery target itself should be canonicalized.
- If the channel needs runtime-owned objects such as a client, token, Bolt
  app, or webhook receiver, register them through
  `openclaw/plugin-sdk/channel-runtime-context`. The generic runtime-context
  registry lets core bootstrap capability-driven handlers from channel
  startup state without adding approval-specific wrapper glue.
- Reach for the lower-level `createChannelApprovalHandler` or
  `createChannelNativeApprovalRuntime` only when the capability-driven seam is
  not expressive enough yet.
- Native approval channels must route both `accountId` and `approvalKind`
  through those helpers. `accountId` keeps multi-account approval policy
  scoped to the right bot account, and `approvalKind` keeps exec vs plugin
  approval behavior available to the channel without hardcoded branches in
  core.
- Core owns approval reroute notices too. Channel plugins should not send
  their own "approval went to DMs / another channel" follow-up messages from
  `createChannelNativeApprovalRuntime`; instead, expose accurate origin +
  approver-DM routing through the shared approval capability helpers and let
  core aggregate actual deliveries before posting any notice back to the
  initiating chat.
- Preserve the delivered approval id kind end-to-end. Native clients should
  not guess or rewrite exec vs plugin approval routing from channel-local
  state.
- Pass that explicit `approvalKind` to `resolveApprovalOverGateway`. This uses
  the canonical `approval.resolve` service and returns the recorded winner when
  another surface answers first. The older explicit `resolveMethod` input
  remains for command-backed controls; new native actions must not use it or
  infer kind from an ID.
- Different approval kinds can intentionally expose different native
  surfaces. Current bundled examples: Matrix keeps the same native DM/channel
  routing and reaction UX for exec and plugin approvals, while still letting
  auth differ by approval kind; Slack keeps native approval routing available
  for both exec and plugin ids.
- `createApproverRestrictedNativeApprovalAdapter` still exists as a
  compatibility wrapper, but new code should prefer the capability builder
  and expose `approvalCapability` on the plugin.

### Narrower approval runtime subpaths

For hot channel entrypoints, prefer these narrower subpaths over the broader
`approval-runtime` barrel when you only need one part of that family:

- `openclaw/plugin-sdk/approval-auth-runtime`
- `openclaw/plugin-sdk/approval-client-runtime`
- `openclaw/plugin-sdk/approval-delivery-runtime`
- `openclaw/plugin-sdk/approval-gateway-runtime`
- `openclaw/plugin-sdk/approval-reference-runtime`
- `openclaw/plugin-sdk/approval-handler-adapter-runtime`
- `openclaw/plugin-sdk/approval-handler-runtime`
- `openclaw/plugin-sdk/approval-native-runtime`
- `openclaw/plugin-sdk/approval-reply-runtime`
- `openclaw/plugin-sdk/channel-runtime-context`

Likewise, prefer `openclaw/plugin-sdk/reply-runtime`,
`openclaw/plugin-sdk/reply-dispatch-runtime`,
`openclaw/plugin-sdk/reply-reference`, and
`openclaw/plugin-sdk/reply-chunking` over broader umbrella surfaces when you
do not need them all.
