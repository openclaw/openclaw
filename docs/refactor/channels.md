---
title: "Channel route unification refactor"
sidebarTitle: "Channel route unification"
---

# Channel route unification refactor

This is a temporary implementation plan. Delete this file before merging the
refactor PR after the code, tests, and PR description prove the plan is
complete.

## Problem

Channel routing is represented several times:

- `ChannelRouteRef` is the SDK route identity shape.
- `ChannelOutboundSessionRoute` is the executable session route returned by
  channel messaging adapters.
- `ConversationRef` and `SessionBindingRecord` identify bound conversations.
- `DeliveryContext` mirrors route fields for sessions, sentinels, tools, and
  protocol compatibility.
- `SessionEntry` stores `deliveryContext`, `lastChannel`, `lastTo`,
  `lastAccountId`, and `lastThreadId` as overlapping last-route fields.

The Discord subagent thread bug happened because a plugin hook had to return a
second ad hoc route object after core already knew a binding existed. TypeScript
could not protect that path because the hook result made `deliveryOrigin`
optional and core treated it as a best-effort delivery hint.

## Goals

- Make `ChannelRouteRef` the canonical route metadata shape inside core.
- Keep `ChannelOutboundSessionRoute` as the channel-owned executable session
  route.
- Keep `ConversationRef` as binding identity, not as a send target.
- Treat `DeliveryContext` as compatibility projection, not core routing truth.
- Share binding-to-route projection between subagent and ACP spawn paths.
- Keep sends in the durable message pipeline with `threadId` and `replyToId`.
- Deprecate ad hoc plugin hook fields once bundled callers use core projection.

## Non-goals

- Do not add a new route type family.
- Do not make core create provider-native threads directly.
- Do not infer child-thread support from a provider having any thread concept.
- Do not remove persisted session compatibility fields in the first pass.
- Do not bypass channel message adapters or durable final delivery.

## Existing contracts to keep

### `ChannelRouteRef`

`src/plugin-sdk/channel-route.ts` owns route normalization and matching. Extend
helpers here only when the concept belongs in the SDK surface. Core-only
projection helpers should live outside the SDK.

### `ChannelOutboundSessionRoute`

`src/channels/plugins/types.core.ts` owns the route returned from
`messaging.resolveOutboundSessionRoute`. Plugins keep provider-native parsing
rules here and should use `buildChannelOutboundSessionRoute` or
`buildThreadAwareOutboundSessionRoute`.

### `ConversationRef`

`src/infra/outbound/session-binding.types.ts` owns binding identity. A
conversation can require plugin resolution before it is routable.

### `DeliveryContext`

`src/utils/delivery-context.types.ts` remains for protocol, session, sentinel,
and tool compatibility. New core code should convert it to `ChannelRouteRef`
before comparing or carrying route state.

## Implementation phases

### Phase 1: route projection helpers

Add a core route projection module with helpers that:

- narrow a `ChannelRouteRef` to a routable route with `channel` and `target.to`;
- project `DeliveryContext` to and from `ChannelRouteRef`;
- project `SessionEntry` route fields to `ChannelRouteRef`;
- project `ConversationRef` to a route through plugin `resolveDeliveryTarget`
  with the existing generic `channel:<conversationId>` fallback;
- project `SessionBindingRecord` to a route using its `conversation`.

Tests must cover:

- normalized channel/account/to/thread fields;
- generic fallback routing when a plugin has no delivery-target projection;
- parent/child thread projection for Slack-like targets;
- same-channel merge without crossing fields between unrelated channels.

### Phase 2: route-first session compatibility

Add a canonical optional route field to session entries, then update session
delivery helpers to read the route first and derive legacy fields from it. Keep
writing legacy fields for compatibility.

Tests must cover:

- route wins over legacy fields when present;
- old session entries still hydrate;
- existing subagent session delivery context is not overwritten by spawn
  request params.

### Phase 3: shared spawn route planner

Move subagent and ACP binding route construction into a shared planner. The
planner returns:

- requester route;
- binding record;
- child delivery route when routable;
- compatibility delivery context;
- whether inline child delivery is allowed.

Subagent and ACP callers must stop open-coding binding-to-delivery projection.

Tests must cover:

- Discord-style child thread delivery;
- Slack-style parent channel plus thread id delivery;
- current-conversation binding without routable child delivery;
- requester origin kept separate from child delivery route.

### Phase 4: bundled plugin hook deprecation path

Move bundled plugins toward core binding projection:

- `subagent_spawning.deliveryOrigin` becomes deprecated compatibility output.
- `subagent_spawning.threadBindingReady` becomes deprecated compatibility
  readiness.
- `subagent_delivery_target` becomes deprecated once core can resolve the bound
  delivery route through `resolveDeliveryTarget`.

Keep public SDK compatibility during the transition and document deprecations in
types and PR notes.

### Phase 5: channel route adapter cleanup

Normalize bundled channel route builders:

- Discord and Slack stay on `buildThreadAwareOutboundSessionRoute`.
- Feishu, Matrix, and other channel route builders use shared route builders
  where possible.
- MS Teams keeps normal thread send support separate from child-thread binding
  until durable final `thread` capability and binding placement are explicitly
  proven.

## Validation checklist

- Focused unit tests for route projection.
- Subagent thread-binding tests.
- ACP spawn route tests.
- Slack, Discord, Feishu, Matrix, and MS Teams channel route tests where touched.
- `pnpm check:changed` or Testbox equivalent before PR.
- Autoreview until no accepted actionable findings remain.
- PR description includes deprecations, compatibility behavior, and proof.
- Delete this file after the PR is green and the description is complete.
