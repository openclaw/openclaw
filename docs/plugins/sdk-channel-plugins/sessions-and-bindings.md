---
summary: "Session conversation grammar, conversation route ownership, and account-scoped conversation binding support for channel plugins"
read_when:
  - Your platform stores extra scope inside conversation ids
  - You need to own conversation route resolution for your channel
  - You are gating current-conversation bindings per account
title: "Channel sessions and bindings"
sidebarTitle: "Sessions and bindings"
---

Map provider conversation ids onto OpenClaw sessions, and own the route and
binding rules that go with them. Part of the [Building channel
plugins](/plugins/sdk-channel-plugins) guide.

## Session conversation grammar

If your platform stores extra scope inside conversation ids, keep that parsing
in the plugin with `messaging.resolveSessionConversation(...)`. That is the
canonical hook for mapping `rawId` to the base conversation id, optional
thread id, explicit `baseConversationId`, and any
`parentConversationCandidates`. When you return `parentConversationCandidates`,
order them from the narrowest parent to the broadest/base conversation.

`messaging.resolveParentConversationCandidates(...)` is a deprecated
compatibility fallback for plugins that only need parent fallbacks on top of
the generic/raw id. If both hooks exist, core uses
`resolveSessionConversation(...).parentConversationCandidates` first and only
falls back to `resolveParentConversationCandidates(...)` when the canonical
hook omits them.

Bundled plugins that need the same parsing before the channel registry boots
can expose a top-level `session-key-api.ts` file with a matching
`resolveSessionConversation(...)` export (see the Feishu and Telegram
plugins). Core uses that bootstrap-safe surface only when the runtime plugin
registry is not available yet.

Use `openclaw/plugin-sdk/channel-route` when plugin code needs to normalize
route-like fields, compare a child thread with its parent route, or build a
stable dedupe key from `{ channel, to, accountId, threadId }`. The helper
normalizes numeric thread ids the same way core does, so prefer it over ad hoc
`String(threadId)` comparisons. Plugins with provider-specific target grammar
should expose `messaging.resolveOutboundSessionRoute(...)` so core gets
provider-native session and thread identity without parser shims.

Owner-derived heartbeat routes pass `deliveryPurpose: "heartbeat-owner"` to this
resolver. Plugins can use it to resolve missing operator delivery context without
relaxing destination requirements for other outbound callers.

## Conversation route ownership

Implement `messaging.resolveConversationRouteOwner(...)` when generic route
matching cannot reproduce the channel's configured and runtime binding rules.
The resolver receives the current config, account, and recorded conversation
identity, including a delivery `target` when it differs from the routing peer.
It must reuse the same precedence and provider identity grammar as inbound
routing.

Ownership inspection is synchronous and read-only. Do not refresh binding
liveness, perform network requests, or infer missing provider facts. Return:

- `{ kind: "agent", agentId }` for an agent-owned route.
- `{ kind: "plugin", pluginId, fallbackAgentId }` for a plugin-owned runtime
  binding. `fallbackAgentId` is the route used when that plugin has no active
  inbound claim handler.
- `{ kind: "unavailable" }` when authoritative owner state is temporarily
  unavailable and the caller should retry.
- `null` when the supplied identity is invalid or cannot be authorized.
- `undefined` to delegate to core's generic owner resolution.

Keep temporary unavailability distinct from `null`: an adapter restart is not
proof that a previously bound conversation is unowned.
Use `inspectConversationBinding(...)` and its `ConversationBindingInspection`
result from `openclaw/plugin-sdk/conversation-binding-inspection-runtime` for this
available/unavailable distinction. This public inspection helper is synchronous,
read-only, and does not refresh binding liveness.

## Account-scoped conversation binding support

Set `conversationBindings.supportsCurrentConversationBinding` when the channel
supports generic current-conversation bindings. `createChatChannelPlugin(...)`
sets this static capability to `true` by default. Channels whose monitor owns a custom binding
adapter must also set `bindingStore: "adapter"`; core then fails closed while
that adapter is unavailable instead of reading or writing generic binding rows.
Older `createManager`-only plugins retain the same adapter-owned behavior.

If support differs by configured account, also implement
`conversationBindings.isCurrentConversationBindingSupported({ accountId })`.
Core evaluates this synchronous hook only after the static capability is
enabled. Returning `false` makes generic current-conversation capability,
bind, lookup, list, touch, and unbind operations unavailable for that account.
Omitting the hook applies the static capability to every account.

Resolve the answer from already-loaded account config or runtime state. This
hook gates only generic current-conversation bindings; it does not replace
configured binding rules or plugin-owned session routing. Contract tests
should cover at least one supported and one unsupported account through the
`ChannelPlugin["conversationBindings"]` contract exported by
`openclaw/plugin-sdk/channel-core`.

Binding ids are local to a channel and account. `SessionBindingService.touch(bindingId, at?, scope?)`
and `unbind({ bindingId, reason, scope })` accept an optional `{ channel, accountId }`
scope to select that owner. For an individual mutation, pass the existing binding's
`conversation` as the scope. For example, to detach a resolved binding:

```ts
await getSessionBindingService().unbind({
  bindingId: binding.bindingId,
  scope: binding.conversation,
  reason: "manual",
});
```

Import `getSessionBindingService` from `openclaw/plugin-sdk/session-binding-runtime`.
For activity updates, use `service.touch(binding.bindingId, at, binding.conversation)`.
Omit scope only for intentional global cleanup or an existing legacy cross-channel
operation. Scope does not change binding ids or require a new adapter method.

Refreshing the same target session and target kind preserves omitted runtime
metadata. Replacing either starts fresh target metadata, so a new session cannot
inherit the previous plugin owner, agent, or label. Keep conversation transport
details and explicit lifecycle settings separate from target metadata.

Use `resolveThreadBindingLifecycle(...)` from
`openclaw/plugin-sdk/thread-bindings-session-runtime` for standard idle and
maximum-age expiration. Plugins with a different legacy timestamp contract can
pass prepared `inactivityExpiresAt` and `maxAgeExpiresAt` values to
`resolveThreadBindingExpiry(...)` on the same subpath. It selects the earlier
deadline and its reason, preferring idle expiration on ties; omitted deadlines
are disabled. The plugin still owns timestamp validation and duration defaults.

Preserve opaque plugin ownership metadata when projecting binding records.
Plugin-owned targets do not require an OpenClaw agent id; use
`isPluginOwnedSessionBindingRecord(...)` from
`openclaw/plugin-sdk/conversation-binding-runtime` to distinguish them from
agent-owned targets before resolving an agent.

For agent-owned targets with an unscoped session key such as `global`, preserve
`metadata.agentId` so routing keeps the binding's owner. An agent-scoped target
key remains authoritative over conflicting metadata.
