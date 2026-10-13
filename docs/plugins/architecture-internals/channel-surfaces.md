---
summary: "Conversation binding callbacks, message tool schemas, target resolution, config-backed directories, and read-only inspection"
read_when:
  - Implementing channel lifecycle surfaces
  - You are resolving channel targets or building config-backed directories
  - You are adding read-only channel inspection for status and doctor paths
title: "Channel surfaces"
sidebarTitle: "Channel surfaces"
---

The surfaces a channel plugin owns: conversation binding callbacks, message tool
schemas, target resolution, config-backed directories, and read-only account
inspection. Part of the [Plugin architecture
internals](/plugins/architecture-internals) guide.

## Conversation binding callbacks

Plugins that bind a conversation can react when an approval is resolved.

Use `api.onConversationBindingResolved(...)` to receive a callback after a bind
request is approved or denied:

```ts
export default {
  id: "my-plugin",
  register(api) {
    api.onConversationBindingResolved(async (event) => {
      if (event.status === "approved") {
        // A binding now exists for this plugin + conversation.
        console.log(event.binding?.conversationId);
        return;
      }

      // The request was denied; clear any local pending state.
      console.log(event.request.conversation.conversationId);
    });
  },
};
```

Callback payload fields:

- `status`: `"approved"` or `"denied"`
- `decision`: `"allow-once"`, `"allow-always"`, or `"deny"`
- `binding`: the resolved binding for approved requests
- `request`: the original request summary, detach hint, sender id, and
  conversation metadata

This callback is notification-only. It does not change who is allowed to bind a
conversation, and it runs after core approval handling finishes.

## Message tool schemas

Plugins should own channel-specific `describeMessageTool(...)` schema
contributions for non-message primitives such as reactions, reads, and polls.
Shared send presentation should use the generic `MessagePresentation` contract
instead of provider-native button, component, block, or card fields.
See [Message Presentation](/plugins/message-presentation) for the contract,
fallback rules, provider mapping, and plugin author checklist.

Provider-native schema extensions require explicit maintainer approval,
channel-owned parsing, documented cross-channel behavior, and capabilities that
`MessagePresentation` cannot express. Discord `components` is the approved
built-in exception for its advanced Components V2 layouts.

Send-capable plugins declare what they can render through message capabilities:

- `presentation` for semantic presentation blocks (`text`, `context`,
  `divider`, `chart`, `table`, `buttons`, `select`)
- `delivery-pin` for pinned-delivery requests

Core decides whether to render the presentation natively or degrade it to text.
Do not expose unapproved provider-native UI escape hatches from the generic
message tool. Deprecated SDK helpers for legacy native schemas remain exported
for existing third-party plugins, but new plugins should not use them.

## Channel target resolution

Channel plugins should own channel-specific target semantics. Keep the shared
outbound host generic and use the messaging adapter surface for provider rules:

- `messaging.inferTargetChatType({ to })` decides whether a normalized target
  should be treated as `direct`, `group`, or `channel` before directory lookup.
  Implicit owner heartbeat delivery requires this direct classification; without
  it, Gateway status reports `waiting for route`.
- `messaging.targetResolver.looksLikeId(raw, normalized)` tells core whether an
  input should skip straight to id-like resolution instead of directory search.
- `messaging.targetResolver.reservedLiterals` lists bare words that are
  channel/session references for that provider. Resolution preserves configured
  directory entries before rejecting reserved literals, then fails closed on a
  directory miss.
- `messaging.targetResolver.resolveTarget(...)` is the plugin fallback when
  core needs a final provider-owned resolution after normalization or after a
  directory miss.
- `messaging.resolveOutboundSessionRoute(...)` owns provider-specific session
  route construction once a target is resolved.

Recommended split:

- Use `inferTargetChatType` for category decisions that should happen before
  searching peers/groups.
- Use `looksLikeId` for "treat this as an explicit/native target id" checks.
- Use `resolveTarget` for provider-specific normalization fallback, not for
  broad directory search.
- Keep provider-native ids like chat ids, thread ids, JIDs, handles, and room
  ids inside `target` values or provider-specific params, not in generic SDK
  fields.

## Config-backed directories

Plugins that derive directory entries from config should keep that logic in the
plugin and reuse the shared helpers from
`openclaw/plugin-sdk/directory-runtime`.

Use this when a channel needs config-backed peers/groups such as:

- allowlist-driven DM peers
- configured channel/group maps
- account-scoped static directory fallbacks

The shared helpers in `directory-runtime` only handle generic operations:

- query filtering
- limit application
- deduping/normalization helpers
- building `ChannelDirectoryEntry[]`

Channel-specific account inspection and id normalization should stay in the
plugin implementation.

## Read-only channel inspection

If your plugin registers a channel, prefer implementing
`plugin.config.inspectAccount(cfg, accountId)` alongside `resolveAccount(...)`.

Why:

- `resolveAccount(...)` is the runtime path. It is allowed to assume credentials
  are fully materialized and can fail fast when required secrets are missing.
- Read-only command paths such as `openclaw status`, `openclaw status --all`,
  `openclaw channels status`, `openclaw channels resolve`, and doctor/config
  repair flows should not need to materialize runtime credentials just to
  describe configuration.

Recommended `inspectAccount(...)` behavior:

- Return descriptive account state only.
- Preserve `enabled` and `configured`.
- Include credential source/status fields when relevant, such as:
  - `tokenSource`, `tokenStatus`
  - `botTokenSource`, `botTokenStatus`
  - `appTokenSource`, `appTokenStatus`
  - `signingSecretSource`, `signingSecretStatus`
- You do not need to return raw token values just to report read-only
  availability. Returning `tokenStatus: "available"` (and the matching source
  field) is enough for status-style commands.
- Use `configured_unavailable` when a credential is configured via SecretRef but
  unavailable in the current command path.

This lets read-only commands report "configured but unavailable in this command
path" instead of crashing or misreporting the account as not configured.
