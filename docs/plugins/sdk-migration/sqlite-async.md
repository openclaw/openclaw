---
summary: "Replace deprecated synchronous SQLite SDK calls before the December 31, 2026 compatibility cutoff"
title: "Migrate synchronous SQLite APIs"
sidebarTitle: "Async SQLite migration"
read_when:
  - Your plugin receives a synchronous SQLite deprecation warning
  - You maintain session, provider, approval, binding, or durable-state integrations
  - You need the complete synchronous-to-async SDK method mapping
---

Migrate synchronous SQLite SDK calls to the awaited or prepared replacements
below. **The final compatibility day is December 31, 2026 (`2026-12-31`).**
Removal ships in the **first January 2027 stable release**, without a Plugin SDK
major version. This deprecation release retains the listed contracts; it does
not remove them. See the [removal timeline](/plugins/sdk-migration/removal-timeline)
for the release and shipped-surface gates.

Start with the families your plugin uses. For direct `Async` replacements, keep
the arguments and await the result. Factories that return adapters or prepared
readers may remain synchronous: await the operations on the returned object as
described below. A Promise-returning wrapper around a native database callback
still runs that callback on the caller's thread; migrate the callback contract,
not just its call site.

These changes preserve stored data, schemas, retention, and update behavior.
Await a write before reading its result or publishing an external effect. Never
retry a failed awaited operation through a deprecated synchronous path. Bundled
plugins target the current host and do not need older-host fallbacks. External
plugins should declare the host version that supplies the capabilities they use.

## Session reads and inbound envelopes

Use `session-store-runtime` for session readers and `channel-inbound` for
prepared envelope construction. The same method mapping
applies to `api.runtime.agent.session` and channel runtime aliases.

```ts
// Before
const entry = api.runtime.agent.session.getSessionEntry(target);
// After
const entry = await api.runtime.agent.session.getSessionEntryAsync(target);
```

| Before                                          | After                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `getSessionEntry`                               | `await getSessionEntryAsync(...)`                                                                               |
| `getConversationSession`                        | `await getConversationSessionAsync(...)`                                                                        |
| `listSessionEntries`                            | `await listSessionEntriesAsync(...)`                                                                            |
| `loadCombinedSessionStoreForGateway`            | `await loadCombinedSessionStoreForGatewayAsync(...)` from `session-transcript-hit`                              |
| `readAmbientTranscriptWatermark`                | `await readAmbientTranscriptWatermarkAsync(...)`                                                                |
| `readSessionUpdatedAt`                          | `await readSessionUpdatedAtAsync(...)`                                                                          |
| `resolveTranscriptSessionKeyBySessionId`        | `await resolveTranscriptSessionKeyBySessionIdAsync(...)`                                                        |
| `loadTranscriptEventsSync`                      | `await loadTranscriptEvents(...)`                                                                               |
| `readTranscriptStatsSync`                       | `await readTranscriptStatsAsync(...)`                                                                           |
| `readTranscriptStatsBatchReadOnlySync`          | `await readTranscriptStatsBatchReadOnlyAsync(...)`                                                              |
| `statSessionEntrySync`                          | `await statSessionEntry(...)`                                                                                   |
| `readAcpSessionEntry`                           | `await readAcpSessionEntryAsync(...)`                                                                           |
| `AcpSessionManager.resolveSession`              | `await manager.resolveSessionAsync(...)`                                                                        |
| `createChannelInboundEnvelopeBuilder`           | `await createChannelInboundEnvelopeBuilderAsync(...)`                                                           |
| `resolveChannelInboundRouteEnvelope`            | `resolveAgentRoute(...)`, then `await createChannelInboundEnvelopeBuilderAsync({ cfg, route })`                 |
| `resolveInboundSessionEnvelopeContext`          | `await resolveInboundSessionEnvelopeContextAsync(...)`                                                          |
| `createInboundEnvelopeBuilder`                  | `await createChannelInboundEnvelopeBuilderAsync({ cfg, route })`                                                |
| `resolveInboundRouteEnvelopeBuilder`            | `resolveAgentRoute(...)`, then `await createChannelInboundEnvelopeBuilderAsync({ cfg, route })`                 |
| `resolveInboundRouteEnvelopeBuilderWithRuntime` | Runtime `routing.resolveAgentRoute(...)`, then `await createChannelInboundEnvelopeBuilderAsync({ cfg, route })` |
| `dispatchInboundDirectDmWithRuntime`            | `await dispatchInboundDirectDm(...)`                                                                            |

The historical transcript-key resolver includes retained `session_windows`
after a session resets. `getSessionEntryByIdAsync(...).sessionKey` is not a
replacement for historical lookup. See the [exact historical lookup
contract](/plugins/sdk-migration/async-transcript-and-tts#historical-transcript-keys).

Prepare the envelope builder once per inbound message. It returns a synchronous
formatter yielding the body string; the older generic builder returned
`{ storePath, body }`. If the caller still needs a store path, resolve it from
the same configured store and route through `runtime.channel.session.resolveStorePath`.
For custom formatting, await `readSessionUpdatedAtAsync` once and pass that
timestamp into the formatter instead of retaining a database-reading callback.

`listSessionEntriesAsync` returns a read-only metadata projection, not detached
snapshots such as saved skill prompts. It does not take the synchronous listing's
`readOnly`, snapshot-hydration, or source-capture options. Use
`getSessionEntryAsync` for a full public entry. Keep authorization for transcript
or metadata disclosure at the existing effect boundary. Memory statistics and
archive readers remain on their existing documented or local subpaths; this
migration does not make private host facades public.

For entry writes, replace opaque callbacks with owner preparation or an
already-prepared patch:

| Before                                       | After                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `patchSessionEntry({ update, ...target })`   | `await prepareSessionEntryPatch({ prepare, ...target })`, or `await applySessionEntryPatch({ patch, ...target })` |
| `updateSessionStoreEntry`                    | `prepareSessionEntryPatch` / `applySessionEntryPatch`                                                             |
| `updateLastRoute` with `assertCommitAllowed` | `await updateLastRouteWithAuthority(...)`                                                                         |
| `upsertSessionUpstreamLink`                  | `await upsertSessionUpstreamLinkAsync(...)`                                                                       |
| `deleteSessionUpstreamLink`                  | `await deleteSessionUpstreamLinkAsync(...)`                                                                       |
| Initialization owner's `prepare().link(...)` | Await `prepare()`, then `await prepared.linkAsync(...)`                                                           |

```ts
// Before: a callback depends on the stored entry.
await patchSessionEntry({ ...target, update: choosePatch });
// After: preparation happens outside the transaction; the owner detects conflicts.
await prepareSessionEntryPatch({ ...target, prepare: choosePatch });
```

See [entry patch conflicts and authority](/plugins/sdk-migration/how-to-migrate#prepare-session-entry-changes)
when translating transaction-local callback behavior.

## Auth profiles and provider readiness

Use the public `provider-auth` surface for profile stores and writes. Bundled
plugins also use the private `provider-auth-runtime` surface for profile metadata
and `agent-sessions` for `AuthStorage` and `ModelRegistry`.
Existing `agent-runtime` and runtime `modelAuth` aliases follow the same mapping;
prefer the focused public subpath when one exists.

```ts
// Before
const auth = AuthStorage.forAgent(agentDir, config);
auth.set(providerId, credential);
// After
const auth = await AuthStorage.forAgentAsync(agentDir, config);
await auth.setAsync(providerId, credential);
```

| Before                                                   | After                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ensureAuthProfileStore`                                 | `await ensureAuthProfileStoreAsync(...)`                                                                                       |
| `ensureAuthProfileStoreForLocalUpdate`                   | `await ensureAuthProfileStoreForLocalUpdateAsync(...)`                                                                         |
| `upsertAuthProfile`                                      | `await upsertAuthProfileAsync(...)`                                                                                            |
| `upsertApiKeyProfile`                                    | `await upsertApiKeyProfileAsync(...)`                                                                                          |
| `isProviderApiKeyConfigured`                             | `await isProviderApiKeyConfiguredAsync(...)`                                                                                   |
| `isProviderAuthProfileConfigured`                        | `await isProviderAuthProfileConfiguredAsync(...)`                                                                              |
| `listUsableProviderAuthProfileIds`                       | `await listUsableProviderAuthProfileIdsAsync(...)`                                                                             |
| `resolveProviderAuthProfileMetadata`                     | `await resolveProviderAuthProfileMetadataAsync(...)`                                                                           |
| `loadAuthProfileStoreWithoutExternalProfiles`            | `await loadAuthProfileStoreWithoutExternalProfilesAsync(...)`                                                                  |
| `loadAuthProfileStoreForRuntime`                         | `await loadAuthProfileStoreForRuntimeAsync(...)`                                                                               |
| `loadAuthProfileStoreForSecretsRuntime`                  | `await loadAuthProfileStoreForRuntimeAsync(agentDir, { ...options, readOnly: true, allowKeychainPrompt: false })`              |
| `saveAuthProfileStore`                                   | `await updateAuthProfileStoreWithLock(...)` from `provider-auth`; mutate the current store under its owner                     |
| `findPersistedAuthProfileCredential`                     | `await findPersistedAuthProfileCredentialAsync(...)`                                                                           |
| `resolvePersistedAuthProfileOwnerAgentDir`               | `await resolvePersistedAuthProfileOwnerAgentDirAsync(...)`                                                                     |
| `resolveAuthStorePathForDisplay`                         | Retire physical database-path displays; display provider/profile identifiers instead. No public async path replacement.        |
| `replaceRuntimeAuthProfileStoreSnapshots`                | `await replaceRuntimeAuthProfileStoreSnapshotsAsync(...)`                                                                      |
| `AuthStorage.create(authPath)`                           | `await AuthStorage.forAgentAsync(agentDir)` using the path's owning agent directory                                            |
| `AuthStorage.forAgent`                                   | `await AuthStorage.forAgentAsync(...)`                                                                                         |
| `AuthStorage.reload`                                     | `await auth.reloadAsync(...)`                                                                                                  |
| `AuthStorage.set`                                        | `await auth.setAsync(...)`                                                                                                     |
| `AuthStorage.remove`                                     | `await auth.removeAsync(...)`                                                                                                  |
| `AuthStorage.logout`                                     | `await auth.logoutAsync(...)`                                                                                                  |
| `ModelRegistry.create`                                   | `await ModelRegistry.createAsync(...)`, or SQL-free `ModelRegistry.fromCapturedSources(...)` when sources are already prepared |
| `ModelRegistry.refresh`                                  | `await registry.refreshAsync(...)`                                                                                             |
| `ModelRegistry.unregisterProvider`                       | `await registry.unregisterProviderAsync(...)`                                                                                  |
| `resolveModelAuthMode`                                   | `await resolveModelAuthModeAsync(...)`                                                                                         |
| `formatModelsAvailableHeader`                            | `await formatModelsAvailableHeaderAsync(...)`                                                                                  |
| `resolveCapabilityModelCandidates`                       | `await resolveCapabilityModelCandidatesAsync(...)`                                                                             |
| `resolveConfiguredCapabilityProvider`                    | `await resolveConfiguredCapabilityProviderAsync(...)`                                                                          |
| `resolveConfiguredRealtimeVoiceProvider`                 | `await resolveConfiguredRealtimeVoiceProviderAsync(...)`                                                                       |
| `getTtsProvider`                                         | `await getTtsProviderAsync(...)`                                                                                               |
| `isTtsProviderConfigured`                                | `await isTtsProviderConfiguredAsync(...)`                                                                                      |
| `resolveExplicitTtsOverrides`                            | `await resolveExplicitTtsOverridesAsync(...)`                                                                                  |
| Runtime `webSearch.listProviders`                        | `await webSearch.listProvidersAsync(...)`                                                                                      |
| `api.runtime.agent.resolveCliBackendDispatchEligibility` | `await api.runtime.agent.resolveCliBackendDispatchEligibilityAsync(...)`                                                       |

Harnesses should consume the host-prepared `params.authStorage`. `AuthStorage`
`get`, `list`, and `has` remain synchronous reads of its prepared view; `login`
and `getApiKey` already return promises. Do not replace a newer whole auth store
with a previously loaded snapshot: use `updateAuthProfileStoreWithLock` for
owner-backed mutation.

Physical database-path displays are retired after 2026-12-31. External plugins
should display provider/profile identifiers; there is no public async API for
the selected database path. The private bundled-plugin helper
`AuthStorage.resolvePathForDisplayAsync` preserves agent-local-versus-shared
database selection, including locators for profiles that do not exist yet.
Metadata helpers return profile/account identities and are not path substitutes.

Provider readiness hooks add an awaited callback:

| Before                                                               | After                                    |
| -------------------------------------------------------------------- | ---------------------------------------- |
| `ImageGenerationProvider.isConfigured`                               | `isConfiguredAsync`                      |
| `MusicGenerationProvider.isConfigured`                               | `isConfiguredAsync`                      |
| `VideoGenerationProvider.isConfigured`                               | `isConfiguredAsync`                      |
| `SpeechProviderPlugin.isConfigured`                                  | `isConfiguredAsync`                      |
| `RealtimeTranscriptionProviderPlugin.isConfigured`                   | `isConfiguredAsync`                      |
| `RealtimeVoiceProviderPlugin.isConfigured`                           | `isConfiguredAsync`                      |
| `RealtimeVoiceProviderPlugin.resolveConfig`                          | `resolveConfigAsync`                     |
| `InternalRealtimeVoiceProviderApi.isBrowserSessionConfigured`        | `isBrowserSessionConfiguredAsync`        |
| `InternalRealtimeVoiceProviderApi.isGatewayRelayConfigured`          | `isGatewayRelayConfiguredAsync`          |
| `InternalRealtimeVoiceProviderApi.resolveBrowserSessionCapabilities` | `resolveBrowserSessionCapabilitiesAsync` |

```ts
// Before
isConfigured: (context) => isProviderApiKeyConfigured(context),
// After
// Preserve synchronous SDK callers through 2026-12-31.
isConfigured: (context) => isProviderApiKeyConfigured(context),
isConfiguredAsync: async (context) => await isProviderApiKeyConfiguredAsync(context),
```

Use the hook's existing context and provider-specific inputs. The host awaits
readiness and prefers the async hook; a failed async hook is not retried through
the legacy one. A readiness result does not authorize later credential use.
Keep the synchronous hooks required by the provider type through 2026-12-31.
Bundled providers also retain synchronous hooks to support callers of the public
synchronous SDK APIs until that date; ordinary runtime callers use async hooks.
See [auth and availability details](/plugins/sdk-migration/how-to-migrate#await-auth-profile-and-provider-availability-operations).

## Approval routing and command authorization

Direct resolvers return promises. Factories whose names end in `Async` below
still return adapters synchronously; their routing and eligibility callbacks
return promises and the host awaits them.

```ts
// Before
const auth = resolveCommandAuthorization(input);
// After
const auth = await resolveCommandAuthorizationAsync(input);

// Factory migration: construction itself stays synchronous.
const adapter = createChannelApprovalNativeRuntimeAdapterAsync(options);
```

| Before                                                                 | After                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `readChannelAllowFromStoreSync`                                        | `await readChannelAllowFromStore(...)`                                      |
| `loadExecApprovals`                                                    | `await loadExecApprovalsReadOnlyAsync(...)`                                 |
| `readExecApprovalsSnapshot`                                            | `await readExecApprovalsSnapshotAsync(...)`                                 |
| `resolveCommandAuthorization`                                          | `await resolveCommandAuthorizationAsync(...)`                               |
| `resolveStoredModelOverride`                                           | `await resolveStoredModelOverrideAsync(...)`                                |
| `resolveCommandArgMenu`                                                | `await resolveCommandArgMenuAsync(...)`                                     |
| `createApproverRestrictedNativeApprovalCapability`                     | `createApproverRestrictedNativeApprovalCapabilityAsync`                     |
| `createChannelApprovalNativeRuntimeAdapter`                            | `createChannelApprovalNativeRuntimeAdapterAsync`                            |
| `createLazyChannelApprovalNativeRuntimeAdapter`                        | `createLazyChannelApprovalNativeRuntimeAdapterAsync`                        |
| `createNativeApprovalChannelRouteGates`                                | `createNativeApprovalChannelRouteGatesAsync`                                |
| `createChannelNativeOriginTargetResolver`                              | `createChannelNativeOriginTargetResolverAsync`                              |
| `createChannelExecApprovalProfile`                                     | `createChannelExecApprovalProfileAsync`                                     |
| `createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes` | `createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync` |
| `createChannelApproverDmTargetResolver`                                | `createChannelApproverDmTargetResolverAsync`                                |
| `createNativeApprovalForwardingFallbackSuppressor`                     | `createNativeApprovalForwardingFallbackSuppressorAsync`                     |
| `resolveExecApprovalSessionTarget`                                     | `await resolveExecApprovalSessionTargetAsync(...)`                          |
| `resolveApprovalRequestSessionTarget`                                  | `await resolveApprovalRequestSessionTargetAsync(...)`                       |
| `resolveApprovalRequestOriginTarget`                                   | `await resolveApprovalRequestOriginTargetAsync(...)`                        |
| `resolveApprovalRequestAccountId`                                      | `await resolveApprovalRequestAccountIdAsync(...)`                           |
| `resolveApprovalRequestChannelAccountId`                               | `await resolveApprovalRequestChannelAccountIdAsync(...)`                    |
| `doesApprovalRequestMatchChannelAccount`                               | `await doesApprovalRequestMatchChannelAccountAsync(...)`                    |
| `doesApprovalRequestSelectChannelAccount`                              | `await doesApprovalRequestSelectChannelAccountAsync(...)`                   |

If one operation needs several routing decisions, prepare
`resolveApprovalRequestSessionDeliveryAsync` once and pass its `sessionDelivery`
to the helpers. Keep current approval, command execution, and delivery authority
at their effect boundaries. See [approval routing and import paths](/plugins/sdk-migration/how-to-migrate#await-session-backed-approval-routing).

## Conversation and native session bindings

Create current-host managers with `createAccountScopedConversationBindingManagerV2`
and register custom adapters with `registerSessionBindingAdapterV2`. The V2
manager factory remains synchronous and returns an async-only receiver.

```ts
// Before
const manager = createAccountScopedConversationBindingManager(options);
const binding = manager.getByConversationId(conversationId);
// After
const manager = createAccountScopedConversationBindingManagerV2(options);
const binding = await manager.getByConversationIdAsync(conversationId);
```

| Before                                                                                                                 | After                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `createAccountScopedConversationBindingManager`                                                                        | `createAccountScopedConversationBindingManagerV2`                                   |
| iMessage `createIMessageConversationBindingManager`                                                                    | `createIMessageConversationBindingManagerV2`; await the same receiver methods below |
| Manager `getByConversationId`, `listBySessionKey`                                                                      | Await `getByConversationIdAsync`, `listBySessionKeyAsync`                           |
| Manager `bindConversation`, `touchConversation`                                                                        | Await `bindConversationAsync`, `touchConversationAsync`                             |
| Manager `unbindConversation`, `unbindBySessionKey`                                                                     | Await `unbindConversationAsync`, `unbindBySessionKeyAsync`                          |
| `registerSessionBindingAdapter` / `SessionBindingAdapter`                                                              | `registerSessionBindingAdapterV2` / `SessionBindingAdapterV2`                       |
| Service or adapter `touch`                                                                                             | `touchAsync`                                                                        |
| Service or adapter `resolveByConversation`                                                                             | `resolveByConversationAsync`                                                        |
| Service or adapter `listBySession`                                                                                     | `listBySessionAsync`                                                                |
| Adapter `inspectByConversation`                                                                                        | `inspectByConversationAsync`                                                        |
| `inspectSessionBindingByConversation`                                                                                  | `await inspectSessionBindingByConversationAsync(...)`                               |
| `inspectConversationBinding`                                                                                           | `await inspectConversationBindingAsync(...)`                                        |
| `resolveRuntimeConversationBindingRoute`                                                                               | `await resolveRuntimeConversationBindingRouteAsync(...)`                            |
| `ChannelConversationBindingSupport.setIdleTimeoutBySessionKey` and runtime `threadBindings.setIdleTimeoutBySessionKey` | `setIdleTimeoutBySessionKeyAsync`                                                   |
| `ChannelConversationBindingSupport.setMaxAgeBySessionKey` and runtime `threadBindings.setMaxAgeBySessionKey`           | `setMaxAgeBySessionKeyAsync`                                                        |
| `setThreadBindingIdleTimeoutBySessionKey`                                                                              | `await setThreadBindingIdleTimeoutBySessionKeyAsync(...)`                           |
| `setThreadBindingMaxAgeBySessionKey`                                                                                   | `await setThreadBindingMaxAgeBySessionKeyAsync(...)`                                |
| `setTelegramThreadBindingIdleTimeoutBySessionKey`                                                                      | `await setTelegramThreadBindingIdleTimeoutBySessionKeyAsync(...)`                   |
| `setTelegramThreadBindingMaxAgeBySessionKey`                                                                           | `await setTelegramThreadBindingMaxAgeBySessionKeyAsync(...)`                        |
| `setMatrixThreadBindingIdleTimeoutBySessionKey`                                                                        | `await setMatrixThreadBindingIdleTimeoutBySessionKeyAsync(...)`                     |
| `setMatrixThreadBindingMaxAgeBySessionKey`                                                                             | `await setMatrixThreadBindingMaxAgeBySessionKeyAsync(...)`                          |

Channel-specific setter names remain on their existing local channel surfaces.
They do not create new cross-plugin imports. Custom adapters own their storage
and must implement the V2 asynchronous and current-owner contracts.

Native harnesses must migrate ownership, not just rename a getter:

| Before                                        | After                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `captureNativeSessionGenerationAuthority`     | Await `prepareNativeSessionGenerationAuthority`, or use the current retained preparation API below |
| `resolveNativeSessionBinding`                 | Await `resolvePreparedNativeSessionBinding` and release its capture                                |
| `reclaimNativeSessionGeneration`              | Prepare authority, then `await reclaimNativeSessionGenerationWithAuthority(...)`                   |
| `NativeSessionGenerationOperations`           | `NativeSessionGenerationOperationsV2`                                                              |
| `createNativeSessionBindingLifecycle`         | `createNativeSessionBindingLifecycleV2`                                                            |
| `NativeSessionBindingStateStore`              | `NativeSessionBindingStateStoreV2`                                                                 |
| `resolveNativeSessionBindingWithAuthority`    | Await `resolvePreparedNativeSessionBinding` and release its capture                                |
| `AgentHarness.resolveSessionRuntimeOwnership` | `resolveSessionRuntimeOwnershipAsync`                                                              |

For new harness code, follow [native session lineage](/plugins/sdk-migration#native-session-lineage):
await `resolvePreparedNativeSessionBinding` or
`retainNativeSessionGenerationAuthority`, consume the owned capture, and call
`release()` in `finally`. Keep the owner alive through effects and terminal
cleanup. A cold or invalidated cached binding cannot substitute for current
owner authority.

## Keyed state

Use `api.runtime.state.openKeyedStoreV2`, or the lazy
`createPluginStateKeyedStoreV2` factory from `plugin-state-store-runtime` when
providing an explicit plugin owner. These factories return immediately; their
methods perform the worker operations.

```ts
// Before
const store = api.runtime.state.openSyncKeyedStore(options);
store.register("item", value);
const stored = store.lookup("item");
// After
const store = api.runtime.state.openKeyedStoreV2(options);
await store.register("item", value);
const stored = await store.lookup("item");
```

| Before                                                                            | After                                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `openSyncKeyedStore`, `createPluginStateSyncKeyedStore`                           | `openKeyedStoreV2`, `createPluginStateKeyedStoreV2`                                       |
| Sync `register`, `registerIfAbsent`                                               | Await V2 `register`, `registerIfAbsent`                                                   |
| Sync `lookup`, `lookupMany`                                                       | Await V2 `lookup`, `lookupMany`                                                           |
| Sync `consume`, `delete`                                                          | Await V2 `consume`, `delete`                                                              |
| Sync `entries`, `count`, `clear`                                                  | Await V2 `entries`, `count`, `clear`                                                      |
| Sync `update`, `deleteIf`                                                         | V2 `observe` plus `compareAndApply`, or an owner-defined worker `createOperation`         |
| V1 `openKeyedStore` / `createPluginStateKeyedStore` receiver `update`, `deleteIf` | Open V2 and replace the callback with `observe` / `compareAndApply`, or `createOperation` |

V1 callback methods already return promises, but their opaque JavaScript
callbacks still execute in a native host transaction. Do not replace an atomic
update with an unconditional lookup and write:

```ts
// Before
await legacyStore.update("counter", (value) => (value ?? 0) + 1);
// After
const observed = await store.observe("counter");
const result = await store.compareAndApply("counter", observed.comparison, {
  operation: "update",
  action: "set",
  value: (observed.value ?? 0) + 1,
});
if (result.status === "conflict") {
  // Recompute from a new observation or report the conflict to the caller.
}
```

For `deleteIf`, evaluate the predicate from an observation, then conditionally
apply `{ operation: "delete", action: "delete" }` with that observation's
comparison. A conflict means no requested mutation committed. Do not replay an
unknown write or a callback with external side effects. See [keyed-state
migration](/plugins/sdk-migration/how-to-migrate#await-plugin-state-and-conversation-bindings)
for multi-key conditions and worker operations. Ordinary V1 data-only methods
are not the callback removal target.

## SessionManager, extension persistence, and replay

Use `agent-sessions` for manager APIs. Every persistence method below must settle
before reading the resulting view or publishing a dependent effect.

```ts
// Before
const manager = SessionManager.open(target);
const id = manager.appendCustomEntry("checkpoint", { stage: "ready" });
// After
const manager = await SessionManager.openAsync(target);
const id = await manager.appendCustomEntryAsync("checkpoint", { stage: "ready" });
```

| Before                                                               | After                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SessionManager.open`                                                | `await SessionManager.openAsync(...)`                                                                            |
| `SessionManager.openBounded`                                         | `await SessionManager.openBoundedAsync(...)`                                                                     |
| `SessionManager.openDetachedBounded`                                 | `await SessionManager.openDetachedBoundedAsync(...)`                                                             |
| `SessionManager.openModelContext`                                    | `await SessionManager.openModelContextAsync(...)`                                                                |
| `SessionManager.readSessionContext`                                  | `await SessionManager.readSessionContextAsync(...)`                                                              |
| `setSessionTarget`                                                   | `await manager.setSessionTargetAsync(...)`                                                                       |
| `reloadPersistedTranscript`                                          | `await manager.reloadPersistedTranscriptAsync(...)`                                                              |
| `SessionManager.appendMessageToTranscript`                           | `await SessionManager.appendMessageToTranscriptAsync(...)`                                                       |
| `appendMessage`                                                      | `await manager.appendMessageAsync(...)`                                                                          |
| `appendMessageWithTranscriptAnchor`                                  | `await manager.appendMessageWithTranscriptAnchorAsync(...)`                                                      |
| `appendCompaction`                                                   | `await manager.appendCompactionAsync(...)`                                                                       |
| `appendResetBoundary`                                                | `await manager.appendResetBoundaryAsync(...)`                                                                    |
| `appendCustomEntry`                                                  | `await manager.appendCustomEntryAsync(...)`                                                                      |
| `appendSessionInfo`                                                  | `await manager.appendSessionInfoAsync(...)`                                                                      |
| `appendCustomMessageEntry`                                           | `await manager.appendCustomMessageEntryAsync(...)`                                                               |
| `appendLeafControl`                                                  | `await manager.appendLeafControlAsync(...)`                                                                      |
| `appendLabelChange`                                                  | `await manager.appendLabelChangeAsync(...)`                                                                      |
| `branch`                                                             | `await manager.branchAsync(...)`                                                                                 |
| `branchWithSummary`                                                  | `await manager.branchWithSummaryAsync(...)`                                                                      |
| `persist`                                                            | `await manager.persistAsync(...)`                                                                                |
| `removeTrailingEntries`                                              | `await manager.removeTrailingEntriesAsync(...)`                                                                  |
| `prepareTranscriptRewrite`                                           | `await manager.prepareTranscriptRewriteAsync(...)`; await its `commit(...)` too                                  |
| `resolveCurrentTurnEntryId({ includeOmittedCustomMessages: true })`  | Await full `SessionManager.openAsync(target)` hydration, then call the loaded-view `resolveCurrentTurnEntryId()` |
| `ExtensionAPI.appendEntry`                                           | `await api.appendEntryAsync(...)`                                                                                |
| `ExtensionAPI.setSessionName`                                        | `await api.setSessionNameAsync(...)`                                                                             |
| `ExtensionAPI.setLabel`                                              | `await api.setLabelAsync(...)`                                                                                   |
| `AgentSession.setSessionName`                                        | `await session.setSessionNameAsync(...)`                                                                         |
| `ProviderPlugin.sanitizeReplayHistory`                               | `sanitizeReplayHistoryAsync`                                                                                     |
| `ProviderReplaySessionState.appendCustomEntry`                       | V2 `appendCustomEntryAsync`                                                                                      |
| `ProviderReplaySessionState`, `ProviderSanitizeReplayHistoryContext` | `ProviderReplaySessionStateV2`, `ProviderSanitizeReplayHistoryContextV2`                                         |
| `sanitizeGoogleGeminiReplayHistory`                                  | `await sanitizeGoogleGeminiReplayHistoryAsync(...)`, or the provider-local awaited replay hook                   |
| `SessionPendingInputReceipt.complete`                                | `await receipt.completeAsync(...)`                                                                               |
| `UserTurnTranscriptRecorder.completeProcessing`                      | `await recorder.completeProcessingAsync(...)`                                                                    |

Use `ExtensionActionsV2`, `ExtensionRuntimeV2`, and `bindCoreAsync` to supply
awaited extension actions. The original action/runtime types and `bindCore`
are not removed merely because they can host legacy actions. SQL-free prepared
view getters, `inMemory()`, and `fromEntries()` remain synchronous. See
[session persistence](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence)
and [provider replay](/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata)
for completion semantics and types.

## Transcript write callbacks, readers, and catalogs

| Before                                                                                                                                                    | After                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `withSessionTranscriptWriteLock`                                                                                                                          | `await withSessionTranscriptWrite(...)`                                                           |
| `withCodexSessionTranscriptMirrorWriteLock`                                                                                                               | `await withCodexSessionTranscriptMirrorWrite(...)`                                                |
| Lock append or `appendSessionTranscriptMessageByIdentity` / `appendSessionTranscriptMessageByIdentityStrict` option `prepareMessageAfterIdempotencyCheck` | `preparation.prepareMessage`, which may return a promise                                          |
| Those appends' `beforeFreshMessageCommit` option                                                                                                          | `preparation.source` using the host-owned source assertion                                        |
| `loadArchivedSessions`                                                                                                                                    | `await loadArchivedSessionsAsync(...)`                                                            |
| `resolveMemorySessionTargets`                                                                                                                             | `await resolveMemorySessionTargetsAsync(...)`                                                     |
| `loadMemorySessionMetadata`                                                                                                                               | `await loadMemorySessionMetadataAsync(...)`, or `loadMemorySessionMetadataBatchAsync` for a batch |
| `readSessionTranscriptCatalogTitle`                                                                                                                       | `await readSessionTranscriptCatalogTitleAsync(...)`                                               |
| `createSessionCatalogSourceActorProjector`                                                                                                                | `await prepareSessionCatalogSourceActorProjector(...)`                                            |
| `createSessionCatalogGitHubLinker`                                                                                                                        | `await prepareSessionCatalogGitHubLinker(...)`                                                    |
| `validateCodexSessionTranscriptReadAdmission`                                                                                                             | `await validateCodexSessionTranscriptReadAdmissionAsync(...)`                                     |
| `validateCodexSessionTranscriptContextVersion`                                                                                                            | `await validateCodexSessionTranscriptContextVersionAsync(...)`                                    |

```ts
// Before
await withSessionTranscriptWriteLock(target, async (writer) => {
  await writer.appendMessage({ message, prepareMessageAfterIdempotencyCheck: prepareSync });
});
// After
await withSessionTranscriptWrite(target, async (writer) => {
  await writer.appendMessage({
    message,
    preparation: { prepareMessage: prepareAsync, source: sourceAuthority },
  });
});
```

Preparation runs after duplicate detection and outside the database transaction.
Return `undefined` to suppress a fresh append; a duplicate keeps its stored bytes
and skips preparation. Keep externally visible side effects out of preparation.
The new write scope does not promise the old callback's native transaction view
or roll back already committed appends. See [locked transcript
preparation](/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation).

## Reply, observer, and harness preparation

| Before                                                                                          | After                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sessionObserver.handleEvent`                                                                   | `await sessionObserver.handleEventAsync(...)`                                                                    |
| `sessionObserver.getCompanionSnapshot`                                                          | `await sessionObserver.getCompanionSnapshotAsync(...)`                                                           |
| `sessionObserver.dispose`                                                                       | `await sessionObserver.disposeAsync()`                                                                           |
| Reply-dispatch `shouldSendToolSummaries`, `shouldSendFullToolDetails`                           | Await `shouldSendToolSummariesAsync()`, `shouldSendFullToolDetailsAsync()`                                       |
| `onVerboseProgressVisibility`                                                                   | `onVerboseProgressVisibilityAsync`; await its visibility getter                                                  |
| `tryDispatchAcpReplyHook` input booleans `shouldSendToolSummaries`, `shouldSendFullToolDetails` | Pass `shouldSendToolSummariesAsync` and `shouldSendFullToolDetailsAsync` predicates                              |
| `GetReplyOptions.onAgentRunStart`                                                               | `onPreparedAgentRunStart` with required `transcriptStart` facts (or `null`)                                      |
| `resolveEntryResetFreshness`                                                                    | `await resolveEntryResetFreshnessAsync(...)`                                                                     |
| `runAgentEndSideEffects`                                                                        | `await runAgentEndSideEffectsAsync(...)`                                                                         |
| Attempt `replyOperation.bindToolAuthoritySnapshot`                                              | `await replyOperation.bindToolAuthoritySnapshotAsync(...)`                                                       |
| Attempt `replyOperation.projectToolAuthorityFingerprint`                                        | `await replyOperation.projectToolAuthorityFingerprintAsync(...)`                                                 |
| Attempt `replyOperation.bindToolAuthorityRoute`                                                 | `await replyOperation.bindToolAuthorityRouteAsync(...)`                                                          |
| `ReplyToolAuthoritySnapshot.fingerprint`, `project`                                             | Await `fingerprintAsync`, `projectAsync`                                                                         |
| `ReplyBackendMessageInjectionV2.queueMessage`                                                   | `queueMessageAsync` with the supplied preparation object                                                         |
| `ReplyBackendMessageInjectionV2.claimPendingUserInputAnswer`                                    | `claimPendingUserInputAnswerAsync` with the supplied preparation object                                          |
| `ReplyBackendMessageInjectionV2.cancelPendingUserInput`                                         | `cancelPendingUserInputAsync` with the supplied preparation object                                               |
| Question-dispatcher `authority.assertCurrent` as the database-reading preparation step          | Await `authority.assertCurrentAsync`, retaining the SQL-free `assertCurrent` at the effect                       |
| `buildWatchedSessionsHarnessContext`                                                            | `await prepareWatchedSessionsHarnessContext(...)`                                                                |
| `listSkillCommandsForAgents`, `listSkillCommandsForWorkspace`                                   | Await `listSkillCommandsForAgentsAsync`, `listSkillCommandsForWorkspaceAsync`                                    |
| `createToolSurface`, `createOpenClawCodingTools`                                                | Await `createToolSurfaceAsync`, `createOpenClawCodingToolsAsync`                                                 |
| `createAgentHarnessToolSurfaceRuntime`                                                          | `await createAgentHarnessToolSurfaceRuntimeAsync(...)`; returned `compactTools` and `cleanup` remain synchronous |
| `getOpenRouterModelCapabilities`                                                                | `await loadOpenRouterModelCapabilities(modelId)`, then SQL-free `getLoadedOpenRouterModelCapabilities(modelId)`  |

```ts
// Before
sessionObserver.handleEvent(event);
// After
await sessionObserver.handleEventAsync(event);
```

`onPreparedAgentRunStart` must still return completion ownership synchronously;
prepare transcript facts before invoking it. Awaited policy preparation is not
permission to execute or disclose later. Preserve the host's current authority
immediately before the effect. See [reply authority](/plugins/sdk-migration/how-to-migrate#await-reply-tool-authority)
and [observer visibility](/plugins/sdk-migration/how-to-migrate#await-session-observer-and-progress-visibility).

## Account services, runtime config, workspace, and TTS

| Before                                                                                         | After                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `modelAccountConnectService.listLinks`, `link`, `unlink`, `list`, `select`, `status`, `cancel` | Await `listLinksAsync`, `linkAsync`, `unlinkAsync`, `listAsync`, `selectAsync`, `statusAsync`, `cancelAsync` |
| GitHub OAuth `cancelAuthorization`, `retireProfile`                                            | Await `cancelAuthorizationAsync`, `retireProfileAsync`                                                       |
| Personal GitHub `cancelAuthorization`, `disconnect`                                            | Await `cancelAuthorizationAsync`, `disconnectAsync`                                                          |
| `getRuntimeConfig` on `runtime-config-snapshot` / `memory-core-host-runtime-core`              | Prepared `readRuntimeConfig()`; for cold preparation, `await captureRuntimeConfigAsyncReader()()`            |
| `resolveCronStorePath`                                                                         | `await resolveCronStorePathAsync(...)`                                                                       |
| `OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace`                                 | `await context.acquireManagedWorkspaceAsync(...)`; release the lease in `finally`                            |
| `ensureAgentWorkspace.beforePersistentApply`                                                   | Await owner preparation before the call and use the SQL-free `guard.assertHost` at the effect                |
| Unprepared `resolveTtsPrefsPath`                                                               | `await resolveTtsPrefsPathAsync(...)`, or pass `preparedTtsPreferences`                                      |
| Unprepared `buildTtsSystemPromptHint`                                                          | `await api.runtime.tts.buildSystemPromptHintAsync(...)`                                                      |

```ts
// Before
const hint = buildTtsSystemPromptHint(config, agentId);
// After
const prepareHint = api.runtime.tts.buildSystemPromptHintAsync;
if (!prepareHint) {
  throw new Error("Update OpenClaw to use async TTS prompt preparation.");
}
const hint = await prepareHint(config, agentId);
```

Bundled plugins can call private `prepareTtsPreferences` once per turn and pass
that result to the supported prepared overloads. Those SQL-free synchronous
overloads are not deprecated. External plugins use the public runtime method
above. See the [public TTS preparation
recipe](/plugins/sdk-migration/async-transcript-and-tts#tts-prompts).

## Debug proxy capture and raw SQLite

| Before                                                                                 | After                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `DebugProxyCaptureStore`, `getDebugProxyCaptureStore`, `acquireDebugProxyCaptureStore` | `await acquireDebugProxyCaptureStoreAsync(...)`; await methods on `lease.store`                                    |
| `closeDebugProxyCaptureStore`                                                          | `await lease.release()` in `finally`                                                                               |
| `DebugProxyCaptureReader`, `createDebugProxyCaptureReader`                             | `AsyncDebugProxyCaptureReader`, `createDebugProxyCaptureReaderAsync`; factory stays synchronous, reads are awaited |
| `initializeDebugProxyCapture`                                                          | `await initializeDebugProxyCaptureAsync(...)`                                                                      |
| `captureHttpExchange`                                                                  | `await captureHttpExchangeAsync(...)`                                                                              |
| `captureWsEvent`, capture context `captureWsEvent`                                     | `await captureWsEventAsync(...)`                                                                                   |
| `finalizeDebugProxyCapture`                                                            | `await finalizeDebugProxyCaptureAsync(...)`                                                                        |

```ts
// Before
const store = acquireDebugProxyCaptureStore(options);
// After
const lease = await acquireDebugProxyCaptureStoreAsync(options);
try {
  // Await capture operations on lease.store.
} finally {
  await lease.release();
}
```

The following `sqlite-runtime` operations have no mechanical async SQL wrapper.
Use `openOpenClawAgentSqliteWorkerStoreV2` and serializable owner commands for
ordinary runtime storage. Move the native implementation into the paired worker
backend using `sqlite-worker-runtime`:

| Before                                                                                                                                 | After                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Writable `openNodeSqliteDatabase`, `openOpenClawAgentDatabase`, `borrowOpenClawAgentDatabase`                                          | Worker store acquisition, preparation, and data-only commands     |
| Legacy worker-store `publicationSource.DatabaseSync`                                                                                   | V2 worker-store publication source                                |
| `withOpenClawAgentDatabaseAsync`, `withOpenClawAgentDatabaseWrite`, `runOpenClawAgentWriteAdmission`                                   | Await V2 worker-store commands; do not pass native host callbacks |
| `runSqliteImmediateTransaction`, `runSqliteImmediateTransactionSync`                                                                   | Transaction inside the worker backend                             |
| `executeSqliteQuerySync`, `executeSqliteQueryTakeFirstSync`, `iterateSqliteQuerySync`, `prepareSqliteQuerySync`, `getNodeSqliteKysely` | Worker-local primitives; expose a data-only operation to the host |

```ts
// Before: awaiting admission does not move this callback off the host.
await withOpenClawAgentDatabaseWrite(options, ({ db }) => updateRows(db, input));
// After: updateRows and its transaction belong to the paired worker backend.
await store.execute({ type: "updateRows", input }, owner.assertCurrent);
```

Preserve explicit read-only inspection, offline Doctor/CLI maintenance custody,
and supported worker-local primitives. Do not treat them as permission for
writable native handles in Gateway handlers. See [worker store construction,
cleanup, and missing-store semantics](/plugins/sdk-migration/how-to-migrate#replace-native-sqlite-runtime-writes).

## Verify the migration

Exercise one read after an awaited in-process write for each migrated owner.
For conditional state updates, prove that a competing write produces a conflict
instead of being lost. Check callback completion and release resources in
`finally`. Confirm that the migrated flow emits no synchronous SQLite
deprecation warning and that errors propagate without a legacy retry.

This guide covers the synchronous SQLite removal window. Unrelated aliases,
active compatibility records, prepared SQL-free overloads, and private/internal
implementation kernels retain their own contracts. Removing the public adapters
in January does not authorize removing live security checks or changing stored
data.
