---
summary: "Draft removal of synchronous SQLite APIs deprecated in stable releases"
read_when:
  - Replacing deprecated synchronous SQLite-backed plugin APIs
  - Checking the proposed removal's stable release history and remaining blockers
---

# Deprecated SQLite API removal draft

Use the awaited owner operations below to prepare plugins for the proposed removal
of deprecated synchronous SQLite APIs. This is an unmerged proposal. No removal
release or date has been announced; maintainers decide when the compatibility
period has elapsed.

OpenClaw deprecates an API, ships the deprecation and replacement in a stable
release, and removes it after a compatibility period in a later normal release.
Beta releases do not establish this history. An API's introduction date or the
creation date of a compatibility record does not establish its first stable
deprecation.

This draft includes only deprecations present in stable `v2026.10.2` or earlier.
The audit checks the owning declaration and public export in stable tags. Newer
deprecations stay available, even when their bundled callers have migrated.

## Proposed removals

The release links establish deprecation history, not a removal deadline or approval.
Methods listed together share an owner and migration; the pull request contains
the complete API diff.

| Deprecated API                                                                                                                                                                                                                                                                                                                                    | Replacement                                                                                                                                   | First stable deprecation                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `readAcpSessionEntry`, `AcpSessionManager.resolveSession`                                                                                                                                                                                                                                                                                         | Await `readAcpSessionEntryAsync` and `resolveSessionAsync`.                                                                                   | [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7)   |
| `SessionBindingService.touch`, `resolveByConversation`, `resolveRuntimeConversationBindingRoute`                                                                                                                                                                                                                                                  | Await `touchAsync`, `resolveByConversationAsync`, and `resolveRuntimeConversationBindingRouteAsync`.                                          | [v2026.9.6](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6)   |
| `setIdleTimeoutBySessionKey` and `setMaxAgeBySessionKey` on `ChannelConversationBindingSupport` and `api.runtime.channel.threadBindings`                                                                                                                                                                                                          | Await the corresponding `Async` setter.                                                                                                       | [v2026.9.6](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6)   |
| Discord `setThreadBindingIdleTimeoutBySessionKey`, `setThreadBindingMaxAgeBySessionKey`; Telegram `setTelegramThreadBindingIdleTimeoutBySessionKey`, `setTelegramThreadBindingMaxAgeBySessionKey`                                                                                                                                                 | Await the corresponding `Async` setter.                                                                                                       | [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7)   |
| `OpenClawPluginNodeHostCommandContext.acquireManagedWorkspace`                                                                                                                                                                                                                                                                                    | Await `acquireManagedWorkspaceAsync`; release its lease in `finally`.                                                                         | [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7)   |
| `loadArchivedSessions`, `resolveMemorySessionTargets`                                                                                                                                                                                                                                                                                             | Await the corresponding `Async` reader from `memory-core-host-engine-sessions`.                                                               | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `buildWatchedSessionsHarnessContext`                                                                                                                                                                                                                                                                                                              | Await `prepareWatchedSessionsHarnessContext` with current host authority.                                                                     | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `captureNativeSessionGenerationAuthority`, `resolveNativeSessionBinding`, `reclaimNativeSessionGeneration`, `NativeSessionGenerationOperations`                                                                                                                                                                                                   | Use `prepareNativeSessionGenerationAuthority`, `resolveNativeSessionBindingWithAuthority`, and `reclaimNativeSessionGenerationWithAuthority`. | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `SessionManager.open`, `openBounded`, `openDetachedBounded`, `setSessionTarget`, `reloadPersistedTranscript`                                                                                                                                                                                                                                      | Await the corresponding `Async` method.                                                                                                       | [v2026.9.6](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6)   |
| `SessionManager.appendMessageToTranscript`                                                                                                                                                                                                                                                                                                        | Await `appendMessageToTranscriptAsync`.                                                                                                       | [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7)   |
| `SessionManager.appendMessage`, `appendMessageWithTranscriptAnchor`, `appendCompaction`, `appendResetBoundary`, `appendCustomEntry`, `appendSessionInfo`, `appendCustomMessageEntry`, `appendLeafControl`, `appendLabelChange`, `branch`, `branchWithSummary`, `removeTrailingEntries`, `persist`, `prepareTranscriptRewrite`, `openModelContext` | Await the corresponding `Async` method, including completion of a prepared rewrite commit.                                                    | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `ExtensionAPI.appendEntry`, `setSessionName`, `setLabel`; `AgentSession.setSessionName`                                                                                                                                                                                                                                                           | Await the `Async` methods; supply `ExtensionActionsV2` and `ExtensionRuntimeV2` through `bindCoreAsync`.                                      | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `ProviderPlugin.sanitizeReplayHistory`, `ProviderReplaySessionState`, `ProviderReplaySessionState.appendCustomEntry`, `ProviderSanitizeReplayHistoryContext`                                                                                                                                                                                      | Use `sanitizeReplayHistoryAsync`, the V2 replay context, and `appendCustomEntryAsync`.                                                        | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `sanitizeGoogleGeminiReplayHistory`                                                                                                                                                                                                                                                                                                               | Use provider-local replay hooks; the awaited helper is `sanitizeGoogleGeminiReplayHistoryAsync`.                                              | [v2026.5.12](https://github.com/openclaw/openclaw/releases/tag/v2026.5.12) |
| Mention Inbox `list`, `dismiss`, `recordCommittedInput`, `invalidate`                                                                                                                                                                                                                                                                             | Await the corresponding `Async` method.                                                                                                       | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| GitHub publication `deferOrphanedRequests`                                                                                                                                                                                                                                                                                                        | Await `deferOrphanedRequestsAsync`.                                                                                                           | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| Gateway placement `listPendingWorkspaceResults`, `getWorkspaceResultReconcilingSessionIds`                                                                                                                                                                                                                                                        | Await the corresponding `Async` method.                                                                                                       | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `ensureAgentWorkspace.beforePersistentApply`                                                                                                                                                                                                                                                                                                      | Prepare database inputs first; retain SQL-free `guard.assertHost` at the effect.                                                              | [v2026.10.1](https://github.com/openclaw/openclaw/releases/tag/v2026.10.1) |
| `DebugProxyCaptureReader`, `DebugProxyCaptureStore`, `getDebugProxyCaptureStore`, `acquireDebugProxyCaptureStore`, `closeDebugProxyCaptureStore`, `createDebugProxyCaptureReader`, `initializeDebugProxyCapture`, `captureHttpExchange`, `captureWsEvent`, `finalizeDebugProxyCapture`, `DebugProxyCaptureContext.captureWsEvent`                 | Acquire `acquireDebugProxyCaptureStoreAsync`, await capture operations, and release the lease.                                                | [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7)   |

The original `ExtensionActions`, `ExtensionRuntime`, and `ExtensionRunner.bindCore`
contracts remain for their retained capabilities; they did not ship a stable
deprecation. Hosts exposing awaited persistence use the V2 contracts and
`bindCoreAsync`.

Await writes before publishing dependent state. Do not retry an asynchronous failure
through a retired synchronous API. Move custom SQL into a registered worker backend;
an opaque JavaScript transaction closure cannot cross the thread boundary.

## Deprecations that have not shipped in stable

The following families remain available. Their first stable deprecation release is
**TBD** at the `v2026.10.2` audit ceiling:

- Raw SQLite database, query, transaction, admission, and callback SDK helpers.
  Recent `Legacy` implementation suffixes do not make the original public names
  unshipped APIs.
- Authentication profile writers and readers, provider/capability selection,
  TTS helpers, model-account methods, and session-observer methods.
- Single-session memory metadata, session context and transcript statistics,
  transcript catalog titles, upstream-link mutations, and Codex transcript
  admission/version validators, including `SessionManager.readSessionContext`.
- Channel allowlists, inbound envelope builders, command/model-override resolution,
  and skill-command discovery.
- Transcript write-lock and preparation callbacks, approval publication and commit
  callbacks, tool-surface factories, and `loadExecApprovals`.
- Account-scoped conversation-binding factories, legacy adapter registration and
  inspection, the newer native binding lifecycle/state-store APIs, `resolveNativeSessionBindingWithAuthority`, and Matrix native idle-timeout and
  maximum-age setters.
- Pending-input completion methods, reply-visibility callbacks, and GitHub
  publication and Gateway placement methods other than the eligible methods above.

An awaited replacement alone does not authorize removal of these contracts.

## Eligible APIs whose consumers still block removal

Plugin-state synchronous keyed stores and opaque `update` / `deleteIf` operations
were deprecated in [v2026.9.5](https://github.com/openclaw/openclaw/releases/tag/v2026.9.5).
They remain used by bundled Codex, ClickClack, Discord, Telegram, Matrix, Reef
migration code, and shared cache owners. Several uses enforce current revocation
or disclosure authority. Removing their exports alone would leave the native
kernel reachable; those owner cutovers must precede removal.

`SessionBindingAdapter.resolveByConversation` and `touch` were deprecated in
[v2026.9.6](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6). They remain
necessary for the retained legacy registration, account-scoped factory, and
inspection contracts. The async service can still consume these legacy adapters.
Removing the service wrappers does not make their shared record kernels worker-only.

Shared session and ACP kernels also remain wherever workers, boot admission,
offline maintenance, or retained runtime contracts need them. Final credential,
approval, tool/command, external-effect, and cross-user disclosure authority checks
remain current. This proposal changes no database schema, retained data, durability,
or update format.

The pull request records current T1 call-site counts, retained callers, and the SDK
API diff. Static call-site counts do not measure statements executed in a warmed turn.
