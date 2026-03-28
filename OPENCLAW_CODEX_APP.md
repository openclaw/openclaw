# OpenClaw Codex App Teams Parity Specification

Status: Draft v1 (implementation spec)

Purpose: Define the coordinated OpenClaw-core and `openclaw-codex-app-server` changes required to move Microsoft Teams support from the current command-bridged MVP to the same first-class plugin/control-surface tier as Telegram and Discord, while staying within existing OpenClaw channel and plugin architecture.

Source snapshot date: 2026-03-26

Path convention:

- `openclaw/...` paths below are repo-root relative inside this repository.
- `openclaw-codex-app-server/...` paths below are repo-root relative inside the sibling app-server repository.

---

## 1. Problem Statement

Today, Teams support for the Codex app-server plugin is usable but not first-class.

The current implementation is split across two realities:

1. `openclaw` already has substantial internal Teams capability:
   - proactive sends
   - Adaptive Card sends
   - proactive message edit/delete
   - Graph-backed message read/pin/unpin/reaction helpers
   - Teams invoke handling for file consent and feedback
2. `openclaw-codex-app-server` only consumes a minimal public Teams runtime surface and therefore falls back to a Teams-specific command bridge for interactive controls.

That leaves Teams below the support tier of Telegram and Discord in four important ways:

- Teams plugin controls are not delivered through `registerInteractiveHandler(...)`.
- Teams picker/status/approval controls are not native interactive callbacks; they round-trip through hidden commands.
- The public plugin runtime does not expose the Teams capabilities the app-server needs for parity, even though several of those capabilities already exist internally in the Teams channel implementation.
- Teams-specific metadata required for channel-grade parity work is not fully preserved through the runtime layers that need it.

This spec closes those gaps without introducing a new generic architecture. The work must extend the existing plugin interactive system, the existing Teams invoke path, and the existing Teams channel runtime.

---

## 2. Grounded Current State

### 2.1 OpenClaw core: existing relevant behavior

The following capabilities already exist internally in the Teams extension:

- Proactive message send: `openclaw/extensions/msteams/src/send.ts`
- Proactive Adaptive Card send: `openclaw/extensions/msteams/src/send.ts`
- Proactive message edit/delete: `openclaw/extensions/msteams/src/send.ts:545+`
- Internal Teams runtime bundle with message read/pin/unpin/reaction helpers: `openclaw/extensions/msteams/src/channel.runtime.ts`
- Channel action handlers already call Teams edit/delete/pin/unpin/read helpers: `openclaw/extensions/msteams/src/channel.ts:566+`
- Teams reply dispatcher already sends typing activities for supported conversation types: `openclaw/extensions/msteams/src/reply-dispatcher.ts`
- Teams monitor already intercepts `message/submitAction` invokes for feedback handling: `openclaw/extensions/msteams/src/monitor-handler.ts:384+`
- Teams conversation store already persists proactive conversation references plus `teamId` and `graphChatId`: `openclaw/extensions/msteams/src/conversation-store.ts`

The following OpenClaw plugin surfaces currently exclude Teams or expose only a minimal Teams surface:

- Plugin interactive channel union currently supports only Telegram, Discord, and Slack: `openclaw/src/plugins/interactive.ts`, `openclaw/src/plugins/types.ts`
- Plugin runtime channel type currently exposes only two Teams methods: `openclaw/src/plugins/runtime/types-channel.ts`
- Teams plugin SDK public export currently exposes only `sendMessageMSTeams` and `sendAdaptiveCardMSTeams`: `openclaw/src/plugin-sdk/msteams.ts`

### 2.2 App-server repo: existing relevant behavior

The app-server plugin currently registers native interactive handlers only for Telegram and Discord:

- `openclaw-codex-app-server/index.ts:29+`

Teams support currently works by:

- sending Teams cards from `buildTeamsPickerCard(...)`: `openclaw-codex-app-server/src/controller.ts:4757+`
- encoding internal actions as command bridge text
- handling those internal commands in `handleTeamsActionCommand(...)` and `handleTeamsBindApprovalCommand(...)`

Teams is already better than a stub because the app-server also has:

- Teams command conversation resolution: `openclaw-codex-app-server/src/controller.ts:394+`
- Teams inbound normalization: `openclaw-codex-app-server/src/controller.ts:439+`
- Teams proactive send paths: `openclaw-codex-app-server/src/controller.ts:6551+`, `:6795+`
- Teams-specific stale-card invalidation in store/controller logic

But the current app-server still lacks first-class Teams parity because:

- no native Teams interactive handler is registered
- no Teams-native interaction context exists in the plugin SDK typing stub
- Teams typing lease is absent in the controller (`startTypingLease(...)` handles only Telegram and Discord)
- Teams rename sync is explicitly unsupported in the controller
- Teams auto-pin/unpin is not wired even though `InteractiveMessageRef` has a Teams variant

### 2.3 Important grounded constraint: Graph channel operations need more than a raw Teams conversation id

Current Graph message helpers in `openclaw/extensions/msteams/src/graph-messages.ts` resolve a channel path only when the target looks like `teamId/channelId`. A normalized Teams `conversation:<bot-framework-conversation-id>` target is treated as a chat target instead.

That is acceptable for proactive send/edit/delete because those use Bot Framework conversation references, not Graph channel paths.

It is not sufficient for channel-grade Graph operations such as:

- channel rename
- channel-scoped message read/pin/unpin operations that require a team/channel path

Therefore parity work must preserve or recover the Graph channel identifier for channel conversations.

---

## 3. Goals

### 3.1 Primary goals

1. Teams MUST be a first-class plugin interactive channel in OpenClaw, on the same architectural tier as Telegram, Discord, and Slack.
2. The app-server plugin MUST stop using Teams-specific hidden command bridge actions for picker/status/bind approval controls.
3. The Teams public plugin runtime surface MUST expose the Teams capabilities the app-server actually needs for parity, reusing existing internal Teams runtime functions where possible.
4. Teams picker/status/approval messages MUST be updatable and clearable in place through native Teams interactive flows.
5. Teams plain-text chat after binding MUST continue to work.
6. The implementation MUST stay within existing OpenClaw patterns:
   - extend the existing plugin interactive system
   - reuse the existing Teams invoke path
   - reuse the existing Teams channel runtime
   - avoid new generic framework layers

### 3.2 Secondary goals

1. Teams typing feedback SHOULD be available during app-server turns where Teams supports typing.
2. Teams rename sync SHOULD be supported for channel conversations when the runtime can resolve the target channel safely.
3. Teams control-surface persistence SHOULD be improved without depending on undocumented Teams channel pin semantics.

---

## 4. Non-Goals

1. This spec does not migrate OpenClaw Teams cards to `Action.Execute`.
   - The implementation MUST stay on the current OpenClaw Teams `Action.Submit` + `message/submitAction` path.
2. This spec does not introduce a new cross-channel interactive abstraction beyond extending the existing plugin interactive registry/dispatch system to Teams.
3. This spec does not require broad public export of every internal Teams helper.
   - Only the app-server parity surface should be exposed.
4. This spec does not depend on undocumented or unverified Microsoft Teams channel pin behavior to claim parity.
   - Channel pinning MAY remain best-effort or unsupported.
5. This spec does not preserve the temporary Teams command bridge as a supported long-term architecture.
   - Once native Teams interactive support lands, the bridge commands SHOULD be removed from the app-server repo.

---

## 5. Parity Definition

For this project, “Teams on the same level as other channels” means the following.

### 5.1 First-class interactive parity

Teams buttons/cards used by bundled plugins MUST be delivered through:

- `registerInteractiveHandler({ channel: "msteams", ... })`
- native Teams invoke handling in OpenClaw core
- native plugin handler dispatch in the plugin runtime

They MUST NOT require a Teams-only hidden command relay such as `/cas_action ...` or `/cas_bind_approve ...`.

### 5.2 Updatable control-surface parity

When a Teams user interacts with a picker/status/approval control, the plugin MUST be able to:

- acknowledge the interaction
- reply ephemerally or normally as the Teams platform allows
- update the original card/message in place when appropriate
- clear or replace interactive controls after they are consumed
- delete the source message when needed

### 5.3 Binding parity

Teams MUST support:

- requesting plugin conversation binding
- displaying pending binding approval controls
- resolving allow/always/deny approval actions
- clearing or replacing approval prompts after action

The Teams binding approval path SHOULD mirror existing Telegram/Discord behavior, where core recognizes plugin binding approval custom IDs before plugin-specific callback dispatch.

### 5.4 Run UX parity

During long-running turns, Teams MAY provide typing feedback where the Teams channel implementation already supports it.

Typing visibility is best-effort only. Teams parity MUST NOT depend on typing being visibly rendered in every Teams client or conversation type.

### 5.5 Channel-scope parity

This spec distinguishes among Teams channel scopes.

- Standard channels: in scope for parity.
- Shared channels: conditionally in scope only if the app is installed/available in that channel and the channel produces the required conversation metadata for proactive send and follow-up operations.
- Private channels: out of scope for this parity spec unless the project explicitly decides to rely on the current preview support and adds separate validation.

The implementation MUST NOT assume that a team-level install automatically makes the app available in every shared or private channel.
The implementation SHOULD rely on capability/installation checks and actual event metadata, not only raw `channelType` or `membershipType` values, when deciding whether a shared/private channel is supported for this rollout.

### 5.6 Rename parity

For Teams channel conversations, `/cas_resume --sync` and `/cas_rename --sync` SHOULD be able to rename the channel when OpenClaw has the metadata and API support to do so safely.

For Teams personal and group-chat conversations, rename sync is not required. The plugin MUST say so clearly instead of pretending support exists.

### 5.7 Durable control-surface parity

The user MUST have a durable way to get back to the Teams control surface. This does not require channel pinning specifically.

Acceptable implementations include:

- stored/updatable status card message references
- chat pinning only where the runtime can return a reversible, documented pin reference
- explicit `/cas_status` control restoration

Channel pinning is not required for parity and MUST NOT be assumed supported without an official Microsoft-documented API path.

---

## 6. Core Design Decisions

### 6.1 Teams native plugin interactions will use `Action.Submit` with structured hidden data

The Teams app-server cards MUST stop encoding internal commands in `messageBack` text.

Instead, interactive buttons MUST use `Action.Submit` with an object-valued `data` payload, with a stable OpenClaw envelope.

Updatable Teams control surfaces MUST be sent as dedicated card/message activities, not as mixed text-plus-attachment sends that depend on Teams splitting behavior to preserve the editable message id.

The callback transport MUST NOT depend on user-visible text.

Required envelope shape:

```json
{
  "openclawInteractive": {
    "version": 1,
    "data": "<raw-callback-data>"
  }
}
```

Where:

- `<raw-callback-data>` is exactly the callback string used on other channels
- plugin callback tokens remain `namespace:payload`
- plugin binding approvals remain the same `pluginbind:...` custom-id strings already used elsewhere
- the payload is expected to arrive in the Teams invoke activity `value`

Rationale:

- this preserves the existing OpenClaw plugin interactive namespace model
- this preserves the existing plugin binding approval custom-id format
- this avoids polluting chat with hidden command text
- this lets Teams core reuse the same parsing order as Telegram/Discord/Slack:
  1. binding approval custom id
  2. plugin interactive namespace dispatch

### 6.2 Adaptive Card version

The app-server Teams control cards SHOULD declare Adaptive Card version `1.2` unless a later version is proven necessary for a specific required element.

Rationale:

- the app-server picker/status cards use simple text + button interactions
- the current Teams command bridge already proved `1.2` is sufficient for the current control card shape
- lower version claims are safer across Teams clients

### 6.3 Teams conversation identity remains anchored on current normalized plugin ids

The app-server and OpenClaw plugin binding logic MUST keep the current normalized Teams identities for binding and proactive send:

- DM: `user:<id>`
- non-DM: `conversation:<bot-framework-conversation-id>`

This spec does not replace the binding key format.

Instead, parity features that need richer Teams semantics MUST rely on supplemental metadata stored in the Teams conversation store and/or plugin-local derived conversation kind.

### 6.4 Teams channel-grade Graph operations require stored Graph channel metadata

OpenClaw MUST extend the Teams conversation store so channel conversations can later resolve a Graph channel path without changing the plugin binding key format.

New required stored field:

- `graphChannelId?: string`

Source of truth for this field:

- Teams inbound activity `activity.channelData.channel.id`

The store entry for a channel conversation MUST retain:

- `conversation.conversationType === "channel"`
- `teamId`
- `graphChannelId`

This is required for safe channel rename support and for any channel-scoped Graph message actions.

---

## 7. Domain Model

### 7.1 OpenClaw Teams conversation store entry

File: `openclaw/extensions/msteams/src/conversation-store.ts`

Existing fields stay. Add:

- `graphChannelId` (string, optional)
  - Default: absent
  - Present only for channel conversations
  - Populated from Teams inbound activity channel metadata
  - Used to derive Graph `/teams/{teamId}/channels/{channelId}` paths later

### 7.2 OpenClaw Teams plugin interactive payload

New logical entity:

- `MSTeamsPluginInteractivePayload`

Fields:

- `version` (integer)
  - Required
  - Initial value: `1`
- `data` (string)
  - Required
  - Exact raw callback string
  - May be either:
    - plugin interactive callback string (`namespace:payload`)
    - plugin binding approval custom id (`pluginbind:...`)

Normalization rules:

- `data` is trimmed before dispatch.
- Empty `data` is invalid.
- Namespace matching uses the same parser already used by `src/plugins/interactive.ts`.

### 7.3 OpenClaw Teams interactive handler context

New type in `openclaw/src/plugins/types.ts`:

- `PluginInteractiveMSTeamsHandlerContext`

Required fields:

- `channel: "msteams"`
- `accountId: string`
- `interactionId: string`
- `conversationId: string`
- `parentConversationId?: string`
- `senderId?: string`
- `senderUsername?: string`
- `auth: { isAuthorizedSender: boolean }`
- `conversationType?: "personal" | "groupChat" | "channel"`
- `teamId?: string`
- `graphChannelId?: string`
- `interaction: {`
  - `kind: "submit"`
  - `data: string`
  - `namespace: string`
  - `payload: string`
  - `messageId?: string`
  - `value?: unknown`
  - `}`
- `respond: {`
  - `acknowledge(): Promise<void>`
  - `reply(params: { text?: string; card?: Record<string, unknown> }): Promise<void>`
  - `followUp(params: { text?: string; card?: Record<string, unknown> }): Promise<void>`
  - `editMessage(params: { text?: string; card?: Record<string, unknown> }): Promise<void>`
  - `clearActions(params?: { text?: string }): Promise<void>`
  - `deleteMessage(): Promise<void>`
  - `}`
- `requestConversationBinding(...)`
- `detachConversationBinding()`
- `getCurrentConversationBinding()`

Notes:

- `acknowledge()` is a semantic no-op if Teams HTTP 200 has already been issued by the monitor layer.
- `messageId` MUST resolve from the incoming activity top-level `replyToId` first. Any payload-local fallback such as `activity.value.replyToId` is secondary.
- `card` is optional because some handlers only need text replacement.

### 7.4 App-server Teams conversation target

File: `openclaw-codex-app-server/src/controller.ts` and related types

The app-server’s internal `ConversationTarget` MUST gain a Teams conversation kind discriminator:

- `teamsKind?: "personal" | "group" | "channel"`

Derivation rules:

- from command context raw target prefixes:
  - `msteams:<id>` => `personal`
  - `msteams:group:<id>` => `group`
  - `msteams:channel:<id>` => `channel`
- from inbound/invoke event data when available:
  - `conversationType === "personal"` => `personal`
  - `conversationType === "channel"` => `channel`
  - otherwise => `group`

This field is plugin-local. It does not change the binding key format.

### 7.5 App-server Teams delivered control-surface reference

File: `openclaw-codex-app-server/src/types.ts`

If the app-server retains Teams pin/unpin support for supported conversation types, the Teams delivered-message reference MUST be able to store a reversible pin token.

Required shape if pinning is implemented:

```ts
{
  provider: "msteams";
  messageId: string;
  conversationId: string;
  pinnedMessageId?: string;
}
```

Rule:

- `pinnedMessageId` MUST only be stored when the runtime returns a real reversible pin resource id.
- The plugin MUST NOT claim a message is safely pinnable/unpinnable without a reversible pin token.
- Channel conversations MUST NOT populate `pinnedMessageId` unless the implementation has an official Microsoft-documented reversible channel pin API path.

---

## 8. OpenClaw Repository Changes

## 8.1 Extend plugin interactive types and dispatch to Teams

Files:

- `openclaw/src/plugins/types.ts`
- `openclaw/src/plugins/interactive-dispatch-adapters.ts`
- `openclaw/src/plugins/interactive.ts`
- `openclaw/src/plugins/registry.ts`
- `openclaw/src/plugins/interactive.test.ts`

Required behavior:

1. Add a Teams interactive handler context, result type, and registration type.
2. Extend `PluginInteractiveHandlerRegistration` to include Teams.
3. Extend `registerInteractiveHandler(...)` acceptance to include `channel: "msteams"`.
4. Extend `dispatchPluginInteractiveHandler(...)` overloads and main dispatcher to include Teams.
5. Add a Teams dispatch adapter that mirrors the existing Telegram/Discord/Slack adapter pattern.
6. Teams callback dedupe MUST use `interactionId` the same way Discord/Slack use interaction ids.

The Teams adapter MUST create the same binding helper trio used on other channels:

- `requestConversationBinding(...)`
- `detachConversationBinding()`
- `getCurrentConversationBinding()`

## 8.2 Add Teams invoke-to-plugin dispatch in the Teams monitor

Files:

- `openclaw/extensions/msteams/src/monitor-handler.ts`
- new helper file(s) under `openclaw/extensions/msteams/src/` if needed
- tests adjacent to monitor-handler tests

Required behavior for `message/submitAction` invokes:

Dispatch order MUST be:

1. file consent invoke path (existing)
2. feedback invoke path (existing)
3. plugin binding approval path (new for Teams)
4. plugin interactive handler path (new for Teams)
5. fall through to existing Teams behavior if no plugin match exists

### 8.2.1 Teams binding approval handling

The Teams monitor MUST mirror the existing Telegram/Discord/Slack approach:

- parse the raw callback data string
- if it matches `parsePluginBindingApprovalCustomId(...)`, resolve it in core
- clear or replace the approval prompt message when possible
- send the approval result back into the same Teams conversation

The approval path MUST be handled in OpenClaw core, not in the app-server plugin.

### 8.2.2 Teams plugin interactive handling

If the callback data does not match a binding approval custom id, the Teams monitor MUST attempt plugin interactive dispatch via `dispatchPluginInteractiveHandler(...)`.

The Teams monitor MUST build a Teams dispatch context containing:

- normalized conversation id
- sender identity
- Teams conversation type
- `teamId` and `graphChannelId` when available
- source message id
- raw activity `value`

### 8.2.3 Teams invoke acknowledgement rules

The Teams monitor MUST preserve the existing invoke timing safety rules:

- do not create a new `invokeResponse` message activity for plugin interactions
- do not block long enough to trigger Teams “unable to reach app” failures
- return/ack the invoke using the same mechanics already used for feedback invoke handling

`respond.acknowledge()` in the plugin handler context MUST therefore be safe to implement as a no-op or already-settled acknowledgement.

## 8.3 Add Teams plugin runtime parity surface

Files:

- `openclaw/src/plugin-sdk/msteams.ts`
- `openclaw/src/plugins/runtime/types-channel.ts`
- `openclaw/src/plugins/runtime/runtime-msteams.ts`
- `openclaw/src/plugins/runtime/runtime-msteams-ops.runtime.ts`
- `openclaw/src/plugins/runtime/runtime-channel.ts`
- `openclaw/src/plugins/runtime/index.test.ts`
- `openclaw/test/helpers/extensions/plugin-runtime-mock.ts`

Required public runtime additions for `api.runtime.channel.msteams`:

### 8.3.1 MUST expose

- `sendMessageMSTeams`
- `sendAdaptiveCardMSTeams`
- `typing.start(...)`
- `conversationActions.editMessage(...)`
- `conversationActions.deleteMessage(...)`
- `conversationActions.editChannel(...)`

### 8.3.2 MAY expose when app-server persistence uses documented chat pin APIs

- `conversationActions.pinMessage(...)`
- `conversationActions.unpinMessage(...)`
- `conversationActions.listPins(...)`

These methods SHOULD be exposed only for Teams conversation types with an official Microsoft-documented reversible pin API. Channel pinning MUST NOT be assumed from current internal experiments or undocumented endpoints.

The Teams runtime surface MUST reuse existing internal Teams functions where they already exist. It MUST NOT duplicate runtime loops.

### 8.3.3 Typing implementation

A new Teams typing lease helper SHOULD be created in the runtime layer, analogous to the Discord and Telegram typing lease helpers.

Implementation requirement:

- reuse the behavior already present in `openclaw/extensions/msteams/src/reply-dispatcher.ts`
- for `personal` and `groupChat`, send typing activities on a best-effort basis
- for `channel`, typing MAY no-op if Teams does not support or visibly render typing there
- failures MUST be swallowed/logged as debug-grade typing failures, not surfaced as turn errors
- parity claims MUST NOT depend on typing being visibly rendered across all Teams clients

## 8.4 Add Teams channel rename support in the channel runtime

Files:

- `openclaw/extensions/msteams/src/graph.ts` or a new focused Graph channel helper module
- `openclaw/extensions/msteams/src/channel.runtime.ts`
- `openclaw/src/plugin-sdk/msteams.ts`
- runtime wiring files listed above

Required behavior:

- add a Teams channel edit helper that can rename a Teams channel via Graph PATCH
- the public runtime method name SHOULD align with Discord’s shape: `conversationActions.editChannel(...)`
- the method MUST only succeed when the target resolves to a real Teams channel
- for personal/group-chat conversations it MUST fail with a typed/structured unsupported-target error or equivalent safe error path

OpenClaw MUST use the existing stored Teams conversation metadata to resolve:

- `teamId`
- `graphChannelId`

It MUST NOT require plugins to pass raw `teamId/channelId` strings.

## 8.5 Fix Graph message-target resolution for Teams channels

Files:

- `openclaw/extensions/msteams/src/graph-messages.ts`
- `openclaw/extensions/msteams/src/conversation-store.ts`
- `openclaw/extensions/msteams/src/monitor-handler/message-handler.ts`
- related tests

Required behavior:

1. Store `graphChannelId` from inbound activity channel metadata.
2. When a Graph-backed Teams message operation receives a normalized `conversation:<id>` target, it MUST consult the Teams conversation store.
3. If the stored reference says the conversation type is `channel` and includes `teamId` + `graphChannelId`, the Graph path MUST resolve to:
   - `/teams/{teamId}/channels/{graphChannelId}`
4. If the stored reference is a personal or group chat, Graph path resolution MUST continue to use the chat path.
5. If a channel operation cannot resolve `teamId` or `graphChannelId`, the runtime MUST fail explicitly rather than silently treating a channel conversation as a chat.

This is required for safe Teams channel rename support and for any channel-scoped Graph message actions.

## 8.6 Update the Teams plugin SDK export surface without overexposing it

File: `openclaw/src/plugin-sdk/msteams.ts`

The Teams public plugin SDK module MUST be expanded only to the set of capabilities needed by the app-server parity work.

It SHOULD export:

- `sendMessageMSTeams`
- `sendAdaptiveCardMSTeams`
- `editMessageMSTeams`
- `deleteMessageMSTeams`
- `pinMessageMSTeams` / `unpinMessageMSTeams` / `listPinsMSTeams` if the app-server uses pin persistence
- `editChannelMSTeams` or the chosen Teams channel rename helper

It MUST NOT become a dumping ground for unrelated Teams internals.

---

## 9. App-Server Repository Changes

## 9.1 Register a native Teams interactive handler

Files:

- `openclaw-codex-app-server/index.ts`
- `openclaw-codex-app-server/src/openclaw-plugin-sdk.d.ts`
- `openclaw-codex-app-server/index.test.ts`

Required behavior:

- register `api.registerInteractiveHandler({ channel: "msteams", ... })`
- add local Teams interactive context typing aligned with upstream OpenClaw additions
- remove the local assumption that only Telegram and Discord can be native interactive channels

## 9.2 Remove the Teams internal command bridge after core support lands

Files:

- `openclaw-codex-app-server/src/commands.ts`
- `openclaw-codex-app-server/src/controller.ts`
- `openclaw-codex-app-server/README.md`
- `openclaw-codex-app-server/openclaw.plugin.json`
- tests that reference the bridge commands

Required removals after native Teams interactive support is available:

- `cas_action`
- `cas_bind_approve`
- `normalizeMSTeamsActionCommand(...)`
- `handleTeamsActionCommand(...)`
- `handleTeamsBindApprovalCommand(...)`

User-facing `/cas_*` commands remain supported. Only the hidden Teams bridge commands are removed.

## 9.3 Rebuild Teams card payloads around native hidden callback data

Files:

- `openclaw-codex-app-server/src/controller.ts`
- tests in `src/controller.test.ts`

`buildTeamsPickerCard(...)` MUST emit `Action.Submit` buttons with structured hidden callback data, not hidden command text.

Required button shape:

```ts
{
  type: "Action.Submit",
  title: button.text,
  data: {
    openclawInteractive: {
      version: 1,
      data: button.callback_data,
    },
  },
}
```

Rules:

- unsupported callback strings are dropped with a warning, as today
- card version stays `1.2` unless a required field forces a higher version
- bind approval buttons use the same raw `pluginbind:...` callback data format already used elsewhere

## 9.4 Add `handleMSTeamsInteractive(...)`

Files:

- `openclaw-codex-app-server/src/controller.ts`
- `src/controller.test.ts`

Required behavior:

- add a native Teams interactive controller path parallel to `handleTelegramInteractive(...)` and `handleDiscordInteractive(...)`
- the handler MUST:
  - resolve the callback token or approval custom id from the native Teams interactive payload
  - map Teams `respond` functions to the plugin’s internal `dispatchCallbackAction(...)` responder shape
  - use `ctx.respond.editMessage(...)` for in-place card replacement when appropriate
  - use `ctx.respond.clearActions(...)` for consumed controls when appropriate
  - use `ctx.respond.deleteMessage()` when callback semantics require deletion
  - use `ctx.respond.reply(...)` / `followUp(...)` for error or completion messages when needed

The handler MUST NOT route Teams callbacks back through text commands.

## 9.5 Replace Teams fake-edit behavior with native edit-in-place behavior

Files:

- `openclaw-codex-app-server/src/controller.ts`
- `src/state.ts`
- tests

Current Teams behavior invalidates callbacks and posts a replacement card because the app-server lacks a native Teams interactive message editing path.

After OpenClaw exposes native Teams interactive handling and message edit support, the app-server MUST:

- prefer native in-place card edits for picker refreshes and approval prompt clearing
- continue invalidating stale callbacks in storage when a control surface is replaced
- stop relying on “post a fresh card and abandon the old one” as the primary Teams update model

Callback invalidation remains required even after native edit support.

## 9.6 Add Teams typing lease support

Files:

- `openclaw-codex-app-server/src/controller.ts`
- local SDK typing file
- tests

`startTypingLease(...)` MUST add a Teams branch using `api.runtime.channel.msteams.typing.start(...)`.

Rules:

- for Teams personal/group conversations, the controller SHOULD start a typing lease the same way it does for Telegram/Discord
- for Teams channel conversations, the controller MAY no-op if the runtime treats typing as unsupported
- typing failures MUST not fail the turn

## 9.7 Add Teams channel rename sync support

Files:

- `openclaw-codex-app-server/src/controller.ts`
- `src/types.ts` if metadata is stored there
- tests

Required behavior:

- `supportsConversationRenameSync(...)` MUST recognize Teams channel conversations
- `renameConversationIfSupported(...)` MUST call Teams runtime channel edit support for Teams channel conversations
- Teams personal/group conversations MUST continue to report rename sync as unsupported

The controller MUST use Teams conversation kind, not only channel id, to decide whether rename sync is available.

The app-server MUST NOT attempt to rename Teams personal/group conversations.

## 9.8 Treat Teams durable control-surface persistence as an explicit design choice

Files:

- `openclaw-codex-app-server/src/controller.ts`
- `src/types.ts`
- tests

The app-server MUST choose one of the following explicit behaviors and document it in code/tests:

### Option A: chat pinning where reversible and officially documented, otherwise skip

- pin Teams binding/status messages only when the runtime returns a reversible `pinnedMessageId`
- unpin only when `pinnedMessageId` is stored
- use this only for Teams conversation types with an official Microsoft-documented reversible pin API
- for unsupported conversation types, skip pinning silently with debug logs

### Option B: no auto-pin; store a durable editable control-surface message reference

- do not auto-pin Teams binding/status messages
- instead retain the message id of the latest Teams status/control card and update it in place
- rely on `/cas_status` as the restoration path when needed

This spec does not require one option over the other. It does require the implementation to pick one intentionally and test it. The implementation MUST NOT pretend safe Teams pin parity exists if it does not have a reversible pin token or an official Microsoft-documented API path.

Given current source reality, Option B is the lower-risk default and SHOULD be preferred unless chat pinning is explicitly validated against official docs and live behavior.

## 9.9 Update local SDK typing to match upstream OpenClaw parity work

File: `openclaw-codex-app-server/src/openclaw-plugin-sdk.d.ts`

Required additions:

- Teams interactive handler context and registration support
- expanded Teams runtime surface
- accurate `inbound_claim` event fields already present upstream (`isGroup`, `metadata`, etc.)

This local typing file MUST remain a faithful mirror of the upstream plugin interface actually required by this plugin.

---

## 10. Behavior Specification

## 10.1 Teams picker lifecycle

### Trigger

A plugin action needs to display a picker or status/control card in Teams.

### Behavior

1. The app-server renders an Adaptive Card with `Action.Submit` buttons carrying `openclawInteractive` hidden data.
2. OpenClaw Teams sends the card proactively.
3. User clicks a button.
4. Teams sends `message/submitAction` invoke.
5. OpenClaw Teams monitor recognizes plugin interactive payload.
6. OpenClaw dispatches the registered Teams interactive handler.
7. The app-server controller resolves the callback and performs the action.
8. The controller edits or clears the original card in place when appropriate.
9. The callback token is invalidated so repeat clicks cannot replay the action.

### Error cases

- `missing_callback_token`
  - User sees “That Codex action expired. Please retry the command.”
- `unknown_namespace`
  - OpenClaw treats the invoke as unmatched and falls through safely.
- `edit_message_unsupported_or_missing_source_message`
  - App-server sends a follow-up reply and still invalidates callbacks.
- `interaction_handler_error`
  - User sees a generic retry message; logs include conversation + interaction id.

## 10.2 Teams binding approval lifecycle

### Trigger

The app-server calls `requestConversationBinding(...)` and receives a pending approval result with buttons.

### Behavior

1. The app-server renders those buttons into a Teams Adaptive Card using the same raw `pluginbind:...` callback strings.
2. User clicks a binding approval button.
3. Teams sends a `message/submitAction` invoke.
4. OpenClaw core parses the raw callback string.
5. If it is a plugin binding approval custom id, OpenClaw resolves the approval before any plugin-specific callback dispatch.
6. OpenClaw clears or replaces the prompt when possible.
7. OpenClaw sends the approval result back to the same conversation.

The app-server plugin MUST NOT own the Teams binding approval bridge after parity work lands.

## 10.3 Teams rename sync lifecycle

### Trigger

User runs `/cas_resume --sync ...` or `/cas_rename --sync ...` in Teams.

### Behavior

- If Teams conversation kind is `channel`, the app-server MAY request channel rename through the Teams runtime.
- If Teams conversation kind is `personal` or `group`, the app-server MUST rename only the Codex thread and MUST state that Teams conversation rename sync is unsupported for that conversation type.

### Error cases

- `missing_channel_graph_metadata`
  - runtime returns a safe error; app-server falls back to Codex-thread-only rename and logs the reason
- `graph_channel_patch_failed`
  - same user-facing fallback behavior; no partial crash

## 10.4 Teams typing lifecycle

### Trigger

App-server starts a long-running turn in a Teams-bound conversation.

### Behavior

- personal/group conversations: start a Teams typing lease on a best-effort basis
- channel conversations: no-op if runtime says unsupported
- typing lease stops when the turn settles

Typing behavior MUST be best-effort.
It MUST NOT affect correctness, callback handling, or turn completion if Teams does not visibly render typing.

---

## 11. Failure Model and Recovery

Error categories:

### 11.1 OpenClaw core

- `teams_invoke_payload_missing`
- `teams_invoke_payload_invalid`
- `teams_binding_approval_expired`
- `teams_plugin_interaction_unmatched`
- `teams_plugin_interaction_duplicate`
- `teams_edit_missing_message_id`
- `teams_delete_missing_message_id`
- `teams_graph_channel_metadata_missing`
- `teams_channel_rename_unsupported_target`

### 11.2 App-server

- `teams_callback_expired`
- `teams_interaction_context_incomplete`
- `teams_picker_edit_failed`
- `teams_typing_start_failed`
- `teams_runtime_surface_unavailable`
- `teams_control_surface_persistence_unsupported`

Recovery rules:

- user-facing interaction failures MUST return a retry-safe message, never crash the plugin service
- callback invalidation MUST still happen when the action was consumed even if the follow-up edit fails
- Teams invoke handling MUST prefer fast acknowledgement and asynchronous follow-up over blocking
- missing Teams channel metadata MUST fail closed for rename/channel Graph actions

---

## 12. Security and Safety Invariants

1. Teams plugin interactive invokes MUST pass the same authorization gate as other Teams interaction flows.
2. Binding approvals MUST only be honored for the exact approval custom id and the exact conversation that originated the request.
3. Callback tokens MUST be invalidated after use.
4. Teams channel rename MUST only be attempted when the runtime can resolve a trusted stored `teamId` + `graphChannelId` from OpenClaw-managed conversation metadata.
5. The app-server MUST NOT trust user-visible text as the source of Teams callback identity. Callback identity comes from hidden submit payload data only.
6. Teams invoke handling MUST not create a second independent “command transport” surface once native interactive support exists.

---

## 13. Reference Algorithms

## 13.1 OpenClaw Teams invoke dispatch

```text
on Teams invoke:
  if activity.name == "fileConsent/invoke":
    handle existing file consent flow
    return

  if activity.name != "message/submitAction":
    fall through

  if feedback payload detected:
    handle existing feedback flow
    return

  rawData = extractOpenClawInteractiveData(activity.value)
  if rawData is empty:
    fall through

  if rawData matches plugin binding approval custom id:
    resolve binding approval in core
    update or clear source prompt if possible
    send result message
    return

  dispatch plugin interactive handler(channel="msteams", data=rawData, ...)
  if matched:
    return

  fall through
```

## 13.2 Graph target resolution for Teams channel actions

```text
resolveGraphMessageTarget(to):
  if to is user:<id>:
    use conversation store findByUserId
    if graphChatId exists -> chat target
    else fail

  if to is conversation:<id>:
    ref = conversationStore.get(id)
    if ref.conversationType == channel:
      require ref.teamId and ref.graphChannelId
      return channel target(teamId, graphChannelId)
    else:
      return chat target(id or ref.graphChatId if needed)

  if raw target already looks like teamId/channelId:
    return channel target directly
```

## 13.3 App-server Teams interactive callback handling

```text
handleMSTeamsInteractive(ctx):
  start controller if needed
  parse ctx.interaction.data

  if data is binding approval custom id:
    this path should already have been handled in OpenClaw core
    return handled/no-op defensive response

  callback = store.getCallback(ctx.interaction.payload)
  if not found:
    reply expired message
    return

  dispatchCallbackAction(callback, responders)
    responders.clear -> clearActions or editMessage fallback
    responders.editPicker -> editMessage(card=buildTeamsPickerCard(...))
    responders.reply -> reply/followUp
    responders.requestConversationBinding -> send Teams approval card from pending reply

  invalidate used callback tokens
```

---

## 14. Test and Validation Matrix

## 14.1 OpenClaw required automated tests

### Plugin interactive core

- register Teams interactive handler successfully
- reject duplicate Teams namespace registrations
- dispatch Teams interactive payload to the correct plugin handler
- dedupe duplicate Teams invoke ids

### Teams monitor invoke handling

- feedback invoke still works unchanged
- plugin binding approval invoke resolves and replies
- plugin callback invoke dispatches the Teams handler
- unmatched Teams invoke falls through safely
- unauthorized Teams invoke is blocked

### Teams runtime surface

- `api.runtime.channel.msteams` exposes the required parity methods
- Teams typing lease starts/stops without throwing
- Teams channel rename helper resolves channel target correctly

### Teams Graph resolution

- channel conversation id + stored metadata resolves to channel Graph path
- personal/group chat resolves to chat Graph path
- missing `graphChannelId` fails closed for channel actions

## 14.2 App-server required automated tests

### Entry / registration

- plugin registers Teams interactive handler when available
- local SDK typing covers Teams interactive channel

### Controller behavior

- Teams interactive callback edits picker in place
- Teams interactive callback clears consumed controls
- Teams expired callback returns retry message
- Teams pending bind approval card is sent without command bridge commands
- Teams typing lease starts for supported Teams conversation kinds
- Teams rename sync works for Teams channels and stays disabled for Teams personal/group chats
- Teams hidden bridge commands are absent after parity landing

### Control-surface persistence

- if pinning is implemented: store and reuse `pinnedMessageId`
- if no pinning is implemented: store/update durable Teams status message reference intentionally

## 14.3 Manual/live validation

A real Teams smoke test MUST cover:

- personal chat bind
- group chat bind
- standard channel bind
- shared channel bind only if shared channels are declared in scope for the rollout
- Teams picker click
- Teams approval click
- Teams status refresh
- Teams clear/replace of consumed controls
- Teams typing visibility during a long turn
- Teams rename sync in a standard channel
- Teams rename sync copy in personal/group chats
- Teams duplicate click / stale callback behavior

Private-channel validation is out of scope unless private channels are explicitly added to scope.

No implementation is complete without one live Teams validation pass.

---

## 15. Pre-Implementation Validation Gates

Before broad implementation begins, the following three validation gates SHOULD be completed and written down in the implementation notes or PR description.

### 15.1 Real Teams invoke payload capture

Capture at least one real `message/submitAction` payload from the current Teams client for a test card using:

- `Action.Submit`
- object-valued `data`
- no `msteams.messageBack` override

Confirm all of the following from the real payload:

- hidden callback data lands under `activity.value`
- `activity.text` is empty or otherwise not relied upon
- top-level `replyToId` identifies the source message/card for update
- the source message id seen in the invoke is sufficient for follow-up update/delete behavior in the current Teams client

If the real payload differs from the expected shape, the implementation MUST update this spec before continuing.

### 15.2 Shared channel scope validation

If shared channels are in scope for the rollout, run one live shared-channel smoke test before claiming support.

Confirm all of the following:

- the app can be added to the host team and the shared channel as required
- the bot receives inbound messages from the shared channel
- the bot receives invoke payloads for card actions in the shared channel
- the conversation metadata received by OpenClaw is sufficient for proactive send, follow-up update, and any channel rename logic used by the implementation

If any of these checks fail, shared channels MUST be downgraded to out-of-scope for the initial parity rollout.

### 15.3 Chat pin validation

If the implementation chooses Option A for durable control-surface persistence, run one live chat pin/unpin test in a Teams chat conversation before claiming support.

Confirm all of the following:

- pin returns a reversible identifier suitable for later unpin
- list-pins returns the expected pinned resource
- unpin works using the stored reversible identifier
- the resulting UX is actually durable/helpful for the app-server control surface

If any of these checks fail, the implementation SHOULD use Option B instead.

## 16. Implementation Order

## Phase 1 — OpenClaw foundation

1. Extend plugin interactive types/dispatcher to Teams.
2. Add Teams invoke dispatch in the Teams monitor.
3. Expand public Teams plugin runtime surface.
4. Persist `graphChannelId` and fix Graph target resolution for Teams channels.
5. Add Teams channel rename runtime helper.

## Phase 2 — App-server migration

6. Add Teams interactive registration and controller handler.
7. Convert Teams card payloads to native hidden interactive data.
8. Remove Teams hidden bridge commands.
9. Add Teams typing lease support.
10. Add Teams rename sync support for channels.

## Phase 3 — Durable controls and polish

11. Implement the chosen Teams control-surface persistence strategy.
12. Update docs/manifests/version floor.
13. Run automated tests in both repos.
14. Run one live Teams smoke test.

---

## 17. Definition of Done

The work is done when all of the following are true:

1. `openclaw-codex-app-server` registers `channel: "msteams"` interactive handling natively.
2. Teams picker/status/approval cards no longer depend on hidden command bridge commands.
3. OpenClaw core handles Teams binding approvals natively in the Teams invoke path.
4. Teams callbacks are dispatched through the same plugin interactive registry architecture used by other supported channels.
5. The Teams public plugin runtime exposes the parity methods required by the app-server and no longer forces the current Teams-only command workaround.
6. Teams channel rename sync works when the conversation is a real Teams channel and metadata is available.
7. The app-server has an explicit, tested Teams control-surface persistence strategy.
8. Tests pass in both repos.
9. A live Teams smoke test confirms the interaction model works in real Teams clients.

---

## 18. Source References

### Local code references

- `openclaw/src/plugins/interactive.ts`
- `openclaw/src/plugins/interactive-dispatch-adapters.ts`
- `openclaw/src/plugins/types.ts`
- `openclaw/src/plugins/runtime/types-channel.ts`
- `openclaw/src/plugin-sdk/msteams.ts`
- `openclaw/extensions/msteams/src/monitor-handler.ts`
- `openclaw/extensions/msteams/src/monitor-handler/message-handler.ts`
- `openclaw/extensions/msteams/src/reply-dispatcher.ts`
- `openclaw/extensions/msteams/src/send.ts`
- `openclaw/extensions/msteams/src/channel.runtime.ts`
- `openclaw/extensions/msteams/src/graph-messages.ts`
- `openclaw/extensions/msteams/src/conversation-store.ts`
- `openclaw-codex-app-server/index.ts`
- `openclaw-codex-app-server/src/controller.ts`
- `openclaw-codex-app-server/src/openclaw-plugin-sdk.d.ts`
- `openclaw-codex-app-server/src/types.ts`

### External primary docs

- Teams cards/actions: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions
- Teams cards format/support: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format
- Teams proactive messaging: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- Teams conversational capability notes (message splitting / message ids): https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability
- Adaptive Cards `Action.Submit`: https://learn.microsoft.com/en-us/adaptive-cards/schema-explorer/action-submit
- Teams shared/private channel app support: https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels
- Teams shared channels guidance: https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/shared-channels
- Graph primary channel: https://learn.microsoft.com/en-us/graph/api/team-get-primarychannel?view=graph-rest-1.0
- Graph channel update: https://learn.microsoft.com/en-us/graph/api/channel-patch?view=graph-rest-1.0
- Graph chat pin message: https://learn.microsoft.com/en-us/graph/api/chat-post-pinnedmessages?view=graph-rest-1.0
- Graph list pinned chat messages: https://learn.microsoft.com/en-us/graph/api/chat-list-pinnedmessages?view=graph-rest-1.0
- Graph pinned chat message resource: https://learn.microsoft.com/en-us/graph/api/resources/pinnedchatmessageinfo?view=graph-rest-1.0
