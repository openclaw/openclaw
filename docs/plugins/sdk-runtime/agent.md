---
summary: "Agent identity, directories, session store, transcripts, and sandbox authority"
read_when:
  - You are resolving agent directories, identity, or thinking defaults
  - You are reading or writing session entries and transcripts from a plugin
  - You need the effective sandbox workspace authority for a session
title: "Plugin runtime agent helpers"
sidebarTitle: "Agent and sessions"
---

The agent, session, transcript, and sandbox surfaces of `api.runtime`, plus the request-bound capabilities a plugin command handler receives. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

## Plugin command runtime helpers

Plugin command handlers receive request-bound capabilities through
`ctx.runtimeContext`. When the command is bound to a current session,
`ctx.runtimeContext.compactCurrent()` runs the same manual compaction
pipeline as `/compact`, including native agent-harness completion and session
token accounting:

```typescript
const compactCurrent = ctx.runtimeContext?.compactCurrent;
if (!compactCurrent) {
  return { text: "This command needs a bound session." };
}

const result = await compactCurrent();
return {
  text: result.compacted
    ? `Compacted to ${result.tokensAfter ?? "an unknown number of"} tokens.`
    : `Compaction did not complete: ${result.reason ?? "unknown reason"}.`,
};
```

This general capability is available to every plugin command, not only Codex.
The host gates it to the current invocation and exact bound session generation.
The capability is absent when no current session is bound; a retained callback
fails closed after the handler settles. Do not retain it or reconstruct
compaction with session-store patches and harness calls. The result contains
`compacted`, optional `reason`, and optional `tokensBefore` and `tokensAfter`
snapshots; OpenClaw owns all persistence and lifecycle coordination.

## Auth-profile resolution

The experimental `openclaw/plugin-sdk/agent-runtime` entrypoint exports
`resolveApiKeyForProfile(...)`. Its optional synchronous
`validateOAuthCredential` callback runs for every OAuth candidate before the
credential is used, adopted, persisted, or returned, including a legacy
`provider:default` fallback. Return normally to accept the credential; throw to
reject it.

Stored credentials are validated before refresh, and refreshed credentials are
validated before persistence. If fallback is allowed and every permitted
candidate is rejected, resolution preserves the original selected-profile
refresh failure. Rejection during active refresh settlement can terminally
fence that credential generation and require reauthentication. Omitting the
callback preserves existing behavior. Set `allowProfileFallback: false` when
the selected profile represents an account boundary that must not rotate to a
different configured profile.

## Session transcript hydration

Use `await SessionManager.openAsync(target, cwd?, contextLimits?, signal?)` from
`openclaw/plugin-sdk/agent-sessions` to load an existing SQLite transcript.
`openBoundedAsync(target, { maxBytes, maxEvents, cwd?, onTruncated?, signal? })`
loads the selected active branch, and `openDetachedBoundedAsync` returns the same
selection without persistence. File-backed SQLite reads run on the history worker.
The synchronous getters consume the prepared view without reading storage.

Full reads transfer bounded chunks from one committed SQLite snapshot without
truncating the transcript to fit the worker. The caller still holds the complete
result in memory; use the bounded methods when the complete history is unnecessary.
Cancellation and failed transfers leave the current view intact and join worker cleanup.

`await manager.setSessionTargetAsync(target, signal?)` replaces a prepared view.
It rejects if the manager changes while reading and leaves the current view intact
when preparation fails. `reloadPersistedTranscriptAsync(signal?)` retains the
manager's runtime working directory. Targets are captured before waiting, including
relative store paths; a truncation callback cannot redirect later persistence.
The binding also retains the resolved state directory and supervisor mode. Later
environment changes do not redirect reloads or writes. `getSessionTarget()` returns
a defensive copy with these storage facts, without unrelated environment values.

These readers do not create a missing database or repair its schema. The session
creation owner must prepare storage first. An existing database with an empty
transcript retains lazy header initialization until its first append. Incognito
SQLite remains with its process-local owner. `SessionManager.inMemory()` stays
synchronous and does not access SQLite.

The synchronous `open`, `openBounded`, `openDetachedBounded`, `openModelContext`,
`setSessionTarget`, and `reloadPersistedTranscript` methods are deprecated
third-party compatibility variants through the next Plugin SDK major. Runtime
code should await their asynchronous counterparts.

## Awaited transcript mutations

Await `appendMessageAsync`, `appendCustomEntryAsync`, `appendSessionInfoAsync`,
and the other `Async` persistence methods before using the resulting view or
publishing dependent work. File-backed writes reuse the canonical SQLite worker,
preserve per-session FIFO ordering, and adopt the committed result before the
promise resolves. User and custom messages and `beforeFreshMessageCommit` use
this same worker path. Incognito retains its process-local persistence owner;
its awaited API preserves the same completion ordering.

The low-level `persistAsync` retains its raw persistence contract and does not add
the supplied entry to the loaded tree; use an append method or reload afterward.
`branchAsync` and `resetLeafAsync` prepare navigation in queue order without
writing a leaf record by themselves. The synchronous `resetLeaf()` remains a
supported in-memory operation.

Synchronous persistence methods retain their immediate return values for
third-party plugins and warn once per method per process. Their removal gate is
the next Plugin SDK major. See the [migration table](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence)
for every replacement, return value, and the additive extension and provider
replay APIs. Transcript formats, schemas, and update behavior are unchanged.

## Native assistant persistence

Assistant producers should reuse the committed row's `idempotencyKey` as the
live `assistant` event's `itemId`. The Gateway retires that exact occurrence
when its run-owned commit is published, including corrections that arrive
after persistence. Separate occurrences need separate identities even when
their text is identical.

Native harnesses that publish committed assistant rows with
`publishSessionTranscriptUpdateByIdentity` from
`openclaw/plugin-sdk/session-transcript-runtime` can include
`update.assistantItemIds`. These are the exact `assistant` stream item IDs whose
live display the committed row replaces or supersedes. Capture the IDs before
awaiting persistence, and publish only after the row commits or an exact
idempotent persistence receipt confirms it. An empty array still identifies a
native row with no preceding streamed item. The persisted row's existing
idempotency key also identifies a later canonical assistant frame.

This field is display provenance, not terminal or run authorization. Existing
session and run ownership checks still apply. It is internal to the host's
transcript notification path: do not put it in the persisted message or public
gateway events. Independently owned keyed commentary and async rows omit it.
When steering commits a completed item, include only that item's ID; a later
unfinished item remains live even if its text repeats the committed row.

The Gateway does not infer ownership from text. An unkeyed producer's text
stays in the live tail until an identity-bearing commit can own it or the run
terminates. Such a producer can temporarily show a duplicate durable row;
the Gateway favors preserving unsaved text over guessing which occurrence to hide.

### Channel delivery mirrors

For a settled `channel-final` delivery, `appendAssistantMirrorMessageByIdentity`
accepts an optional `sourceRunId` from the producing run. Pass it when a queued
answer can settle after another assistant message has been committed. The helper
correlates matching text with an uncorrelated assistant occurrence in that run,
in transcript order, so repeated answers retain distinct identities.

The delivery receipt remains stored, but `chat.history` presents the correlated
answer once. This does not change provider replay. A run ID is provenance, not
write authorization; the existing session checks still apply. If no source run
is supplied, correlation retains the latest-message behavior.

## Bounded model context

Use `await SessionManager.openModelContextAsync(...)` from
`openclaw/plugin-sdk/agent-sessions` with optional `limits: { maxBytes, maxEvents }`.
Bounded reads are strict by default. The reader measures projected payload bytes
in SQLite before loading them and selects a recent context with its latest
compaction or reset boundary. It preserves
tool-result ownership and rejects a limit that cannot retain the newest complete
frame or required boundary. Stored transcripts stay unchanged. Omitting `limits`
keeps the full selected context. Async reads retain admission, anchor, and
cancellation checks.

For a temporary model-only view, callers may explicitly add
`toolResultOverflow: "omit"` to `limits`. If the newest atomic tool frame would
otherwise leave no fitting context, recovery replaces only the tool-result bodies
needed to fit with omission notices, before loading those bodies from SQLite.
Each notice identifies the tool, call, and original projected event size. Recovery
retains the latest historical user request and complete owned call/result frames.
Unselected result bodies and tool-call arguments remain intact.

This is a lossy model view, not a full-fidelity history API. It does not rewrite
canonical transcripts or change evidence and fork readers. The same byte/event
limits, required boundaries, and tool-result ownership checks still apply. Reads
still fail if required user messages, call arguments, summaries, or event counts
cannot fit, or result ownership is ambiguous. Omitting `toolResultOverflow`
preserves strict bounded-read behavior.

## Scoped session visibility

`createSessionVisibilityChecker` from
`openclaw/plugin-sdk/session-visibility` supports narrow host-owned session
grants through `registerScopedAccessProvider(syncProvider, { resolveAsync })`.
Both callbacks receive `{ action, requesterSessionKey, targetSessionKey }` and
return `{ expectedSessionId }` only for an authorized, exact session incarnation,
or `undefined` when no scoped grant applies. The optional `resolveAsync`
callback returns a promise. Providers own matching the action and both session
keys against current authoritative state.

Session tools await `createSessionVisibilityChecker.resolveScopedAccessAsync(...)`.
For each registration, it uses `resolveAsync` when supplied, otherwise the
synchronous provider. Providers run in registration order. An empty, invalid,
or rejected async result does not retry that registration's synchronous callback;
other registered providers and then ordinary visibility policy still apply.
Incognito targets cannot receive scoped grants.

The direct checker's `check(...)`, the guard's `check(...)`, and
`resolveScopedAccess(...)` remain synchronous and call the synchronous provider
afresh. Existing external callers keep this contract. Older hosts ignore the
optional registration argument, so plugins supporting those hosts must retain
a fresh synchronous implementation; an asynchronously populated startup cache
is not a replacement.

One registration owns both callbacks. Its returned cleanup function unregisters
both. Re-registering the same synchronous function replaces that registration
without changing its position; an old cleanup function cannot remove the
replacement. Async resolution checks the exact registration after awaiting it
and discards results from an unregistered or replaced owner. Newly registered
providers participate only in subsequent resolutions. Wire cleanup into the
plugin's existing runtime lifecycle and revalidate plugin-owned authority after
the provider's own awaited work.

## Agent and session namespaces

<AccordionGroup>
  <Accordion title="api.runtime.agent">
    Agent identity, directories, and session management.

    ```typescript
    // Resolve the agent's working directory (agentId is required)
    const agentDir = api.runtime.agent.resolveAgentDir(cfg, agentId);

    // Resolve agent workspace
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);

    // Get agent identity
    const identity = api.runtime.agent.resolveAgentIdentity(cfg);

    // Get default thinking level
    const thinking = api.runtime.agent.resolveThinkingDefault({
      cfg,
      provider,
      model,
    });

    // Validate a user-provided thinking level against the active provider profile
    const policy = api.runtime.agent.resolveThinkingPolicy({ provider, model });
    const level = api.runtime.agent.normalizeThinkingLevel("extra high");
    if (level && policy.levels.some((entry) => entry.id === level)) {
      // pass level to an embedded run
    }

    // Resolve a synchronous create target for a session catalog
    const target = api.runtime.agent.resolveSessionCatalogCreateTarget({
      config: api.runtime.config.current(),
      requestedAgentId: agentId,
      provider: "example",
      modelIds: ["example-model"],
      agentRuntime: "example-cli",
    });

    // Get agent timeout
    const timeoutMs = api.runtime.agent.resolveAgentTimeoutMs(cfg);

    // Ensure workspace exists
    await api.runtime.agent.ensureAgentWorkspace(cfg);

    // Run an embedded agent turn
    const result = await api.runtime.agent.runEmbeddedAgent({
      sessionId: "my-plugin:task-1",
      runId: crypto.randomUUID(),
      workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId),
      prompt: "Summarize the latest changes",
      timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
    });
    ```

    `runEmbeddedAgent(...)` is the neutral helper for starting a normal OpenClaw agent turn from plugin code. It uses the same provider/model resolution and agent-harness selection as channel-triggered replies.

    The caller owns `terminalReplyExpectation`: `"required"` for a requested response, or `"optional"` for work that may finish silently. A model's `NO_REPLY` is empty output, not permission to waive a required response. Recovery after settled tools uses a tool-free finalization pass rather than repeating completed actions.

    If your adapter delivers a final reply before the run returns, provide `resolveReplyDelivery(minimumAssistantMessageIndex?)`. Return `"delivered"` for a confirmed final to the current source, `"pending"` while its transport owns delivery or the outcome is uncertain, and `"missing"` when no final was delivered. Bind observations to this run and input; exclude earlier-input receipts when the supplied lower bound advances. Collecting a block, showing a preview, or writing an external channel's transcript is not a delivery receipt. Observation failures retain pending custody instead of authorizing another reply.

    Existing plugins that do not supply `resolveReplyDelivery` retain caller custody when the runtime hands a nonempty answer block to `onBlockReply`. [Block replies](/concepts/streaming#block-streaming-channel-messages) are normal channel messages, not previews. The runtime treats this compatibility handoff as `"pending"`, never `"delivered"`: it prevents duplicate recovery without proving delivery or making the response optional. A callback that throws or rejects retains uncertain custody because it may already have sent the reply. Reasoning, commentary, status/progress notices, empty blocks, and `onPartialReply` previews do not establish this custody.

    An explicit `resolveReplyDelivery` always takes precedence. If `onBlockReply` only collects output, updates a preview, or fails before sending, return `"missing"` when the adapter can confirm that no source transport owns a final response; this permits required recovery. Migrate delivery adapters to the observer so they can report actual receipts and uncertain sends. The block callback returns no delivery result, so a generic rejection alone does not authorize recovery. Legacy custody is scoped to the run and assistant-message index, retired for later inputs and on cancellation or completion; blocks without an index apply only to the initial input.

    The optional `githubPublicationAvailable` input shipped in 2026.9.4 is deprecated and ignored. Remove it from plugin calls: the host checks the current session and Gateway for every attempt. The SDK accepts the old input until the next Plugin SDK major; it does not grant or disable publication tools.

    `resolveCliBackendDispatchEligibility({ provider, model, agentId, authProfileId, config, agentDir, workspaceDir })` shares the embedded runner's CLI-backend dispatch decision (route, the backend's declared `subscriptionAuthDispatch` capability, stored credential mode — honoring an explicitly pinned `authProfileId`) with callers that opt embedded runs into `cliBackendDispatch: "subscription-auth"`. It returns `{ provider }` when the run would execute through the CLI backend and `undefined` when it stays on the direct passthrough, so callers can budget timeouts for the run that will actually execute.

    Raw calls using this CLI opt-in keep the saved session fallback for same-agent child model selection. Explicit and configured child models still take precedence.

    `resolveThinkingPolicy(...)` returns the provider/model's supported thinking levels and optional default. Provider plugins own the model-specific profile through their thinking hooks, so tool plugins should call this runtime helper instead of importing or duplicating provider lists.

    `normalizeThinkingLevel(...)` converts user text such as `on`, `x-high`, or `extra high` to the canonical stored level before checking it against the resolved policy.

    `resolveSessionCatalogCreateTarget(...)` is the supported synchronous policy seam for trusted native plugins that implement `SessionCatalogProvider.resolveCreateSession`. It selects the first candidate model routed to the requested runtime and allowed for the requested or default agent. It returns `undefined` when no candidate satisfies both policies. Use this helper instead of importing or duplicating core model-selection policy in a plugin.

    **Session store helpers** are under `api.runtime.agent.session`:

    ```typescript
    const entry = await api.runtime.agent.session.getSessionEntryAsync({ agentId, sessionKey });
    const match = await api.runtime.agent.session.getSessionEntryByIdAsync({ agentId, sessionId });
    for (const { sessionKey, entry } of api.runtime.agent.session.listSessionEntries({ agentId })) {
      // Iterate session rows without depending on the legacy sessions.json shape.
    }
    await api.runtime.agent.session.prepareSessionEntryPatch({
      agentId,
      sessionKey,
      prepare: () => ({ thinkingLevel: "high" }),
    });

    const created = await api.runtime.agent.session.createSessionEntry({
      cfg,
      key: "agent:main:my-plugin:task-1",
      initialEntry: {
        agentHarnessId: "my-harness",
        modelSelectionLocked: true,
        pluginExtensions: { "my-plugin": { phase: "initializing" } },
      },
      afterCreate: async () => ({
        pluginExtensions: { "my-plugin": { phase: "ready" } },
      }),
    });

    const storePath = api.runtime.agent.session.resolveStorePath(cfg.session?.store, { agentId });
    await api.runtime.agent.session.runWithWorkAdmission(
      { storePath, sessionKey },
      async (signal) => {
        // Create or update the session, then pass signal to the admitted agent run.
      },
    );
    ```

    Prefer `getSessionEntryAsync(...)`, `getSessionEntryByIdAsync(...)`, `prepareSessionEntryPatch(...)`, or `upsertSessionEntry(...)` for session workflows. These helpers address sessions by agent/session identity so plugins do not depend on the legacy `sessions.json` storage shape. Use `preserveActivity: true` for metadata-only patches that should not refresh session activity, and `replaceEntry: true` only when the callback returns a complete entry and deleted fields must stay deleted. Doctor and migration paths can combine `fallbackEntry`, `skipMaintenance`, and `requireWriteSuccess` for one atomic canonical-store repair.

    Both async getters are also exported from the existing `openclaw/plugin-sdk/session-store-runtime` subpath. They return the complete public entry projection, excluding host-private fields, or `undefined` for a missing entry. The by-ID result includes `{ sessionKey, entry }` from the same selected owner. An explicit `storePath` selects that physical store; an omitted path inside a host-supplied incognito scope retains that scope. Managed runtime calls reject if their plugin owner retires while the read is pending. Returned metadata does not authorize a later effect; revalidate the caller's current authority at that boundary. The SDK and runtime `getSessionEntry(...)` getters are deprecated in favor of `getSessionEntryAsync(...)` and will be removed at the next Plugin SDK major. Their synchronous behavior remains unchanged during the migration window. The existing `readSessionUpdatedAt(...)` deprecation follows the same removal window; await `readSessionUpdatedAtAsync(...)` instead.

    By default, `getSessionEntryByIdAsync(...)` chooses the first visible exact ID match in session-key order, falling back to trimmed legacy IDs only when there is no exact match. Pass `orderBy: "updatedAt"` to choose the most recently updated match across exact and trimmed IDs, with session-key order breaking ties. Active Memory uses this option to preserve its most-recent-session selection.

    Incognito actor support is inactive preparation: ordinary unbound incognito calls still use the existing host-owned store and allocate no actor. Explicit host bindings exercise the actor arm; fresh selected absence remains distinct from an ended retained actor. `rethrowIncognitoSessionError(error)` preserves those typed refusals in optional-read error handlers. Active Memory awaits entry, eligibility, and status preparation and does not turn actor loss into empty recall. No schema, retention, or update migration is introduced.

    When patch authority can change while preparation awaits, use `authority: { kind: "host", assertCurrent }` for a live, database-free owner check, or pass the host-provided prepared source as `authority: { kind: "source", source }`. The worker compares the captured entry and rechecks authority before commit; conflicts reject without replaying preparation. The legacy `patchSessionEntry` and transaction-local callback guard remain deprecated compatibility adapters. See [session entry migration](/plugins/sdk-migration/how-to-migrate#prepare-session-entry-changes) for data-only patches and the retained incognito/cross-store routes.

    For native conversation controls, `getConversationSession(...)` from `openclaw/plugin-sdk/session-store-runtime` reads the current recorded binding for one transport address. Supply `agentId`, `channel`, `accountId`, `kind` (`direct`, `group`, or `channel`), and the ingress `peerId`; optional `threadId` selects an exact thread. Optional `storePath` and `env` select the same agent store as other session helpers. It returns `{ sessionKey, sessionId }`, or `undefined` when no current binding exists, and follows session resets without creating a session. It does not list active runs or infer a parent address. Targeted Stop dispatch can provide `replyOptions.isCommandTargetCurrent`, a synchronous in-process owner check carried to the cancellation boundary. A false result rejects a stale target; cancelled owners cannot mark a replacement session aborted.

    `captureSessionEntryCurrentCheck(...)` from `openclaw/plugin-sdk/session-binding-runtime` prepares public entry metadata and its original source together. Supply `fields` for the exact policy values the operation consumes, and call the returned synchronous `assertCurrent()` at the effect boundary after awaited work. Session identity and lifecycle remain part of the predicate unless `matchGeneration: false` is explicitly selected. An optional `expected` entry rejects a changed selection during preparation. The returned entry is descriptive data; mutating it does not alter the retained guard.

    `createSessionEntry(...)` creates a new canonical session row and transcript. Its trusted `initialEntry` surface is deliberately narrow. A plugin may select an owned `agentHarnessId`; seed an owned CLI backend with `cliBackendId`, `model`, and `cliSessionBinding`; or seed a persistent ACP session with `acpBackendId` and `acpSessionBinding: { acpAgentId, agentSessionId }`. The ACP variant persists the supplied native agent session id through the canonical SQLite ACP metadata owner so the first turn resumes that external session. The injected runtime restricts plugin-owned CLI and ACP sessions to the calling plugin's `plugin:<id>:` namespace; harness ids must be owned through `registerAgentHarness(...)`. These are ownership invariants, not a sandbox between in-process plugins. Creation rejects an existing row; `label`, `displayName`, and `spawnedCwd` are separate creation fields rather than trusted-entry patches.

    Optional `displayName` seeds the existing presentation field atomically with the new row. The host trims it and truncates it to at most 500 UTF-16 code units without splitting a surrogate pair; empty or whitespace-only input leaves it unset. Duplicate display titles are allowed and do not claim an addressable label. Explicit `label` values retain normal uniqueness validation and display priority. Reuse and interrupted-initializer recovery preserve all stored labels and title snapshots, including absent titles and older automatically assigned labels. This create-only input does not permit title changes through `initialEntry` or the `afterCreate` final patch, and is not a public `sessions.create` Gateway parameter.

    Before advertising an ACP-backed action, use `resolveAcpSessionAvailability(...)` from `openclaw/plugin-sdk/acp-runtime`. It applies the canonical enablement, dispatch, allowed-agent, registered-backend, and backend-health checks; recheck it immediately before creating the session.

    ACP manager inputs accept an optional `agentId` identifying the OpenClaw session owner; `agent` selects the external harness. Carry the resolved owner from `resolveSession(...)` through subsequent calls, including controls and cleanup. `expectedOwnerKey` retains its parent-session meaning.

    Backends can advertise `ownerAwareSessions: 1` on `AcpRuntime`, including their lazy facade. This promises owner isolation for both `ensureSession(...)` and `prepareFreshSession(...)`. Their optional `agentId` and the handle's optional `agentId` preserve existing backend source compatibility. Qualified keys continue to work with older backends; bare sessions requiring isolation reject backends without the capability before effects. The logical `sessionKey` remains the SDK/tool identity. An optional `persistedHandle` is a projection for detecting old backend locators, not execution authority. Migration-required errors must propagate through reset and recovery without clearing metadata.

    ACP backends can return `AcpRuntimeConfigOptionResult` from `setConfigOption(...)`: a complete `configOptions` array of `{ id, category?, currentValue, options? }`, where `currentValue` is a string or boolean. Select `options` contain `{ value }` entries or groups of `{ options: [{ value }] }`. OpenClaw reconciles an already-selected thinking override from the accepted `thought_level` category or a recognized thinking key. Automatic model replay preserves a pending thinking value only when it is still current or selectable; explicit controls always use the accepted value. An empty array removes that override; omitted or null `category` is allowed, and backend defaults are not pinned. Existing third-party backends returning `void` retain requested-value persistence. Return the snapshot after backend persistence succeeds; reject failed writes.

    Creation holds the session lifecycle mutation fence through `afterCreate`, so new work waits for plugin-owned initialization to finish and pre-existing admitted work makes creation fail. The callback receives a clone of the created state. If it returns a patch, that patch may contain only `pluginExtensions`, and its value is the complete final `pluginExtensions` field. A callback or final-persistence failure rolls back the unchanged new row and transcript; guarded rollback preserves a row changed or claimed concurrently. `recoverMatchingInitialEntry: true` is only for retrying interrupted initialization when the persisted trusted fields match exactly, and recovery requires `afterCreate` to return a final patch.

    The callback's optional `initialization` handle belongs to this exact pending child, source incarnation, registry and creation lifetime. Use `assertCurrent()` across awaited preparation and writes; retained handles reject after readiness or closure. Only the host's registered rollback path can use `assertRollbackCurrent()`. Older hosts may omit the handle, so features requiring creation authority must refuse that path rather than fabricate a run.

    `initialization.prepareNativeToolPolicy(model)` checks the host-fixed child's native execution environment and harness policy, then returns its persistent web-search policy. The bounded native model selection is data, not authority to change the child or registry. This handle does not construct tools, invoke prompt hooks, provision requester resources or expose executors, approvals or credentials. Actual admitted runs own their available tools and live hooks; inherited native declarations remain metadata.

    Use `runWithWorkAdmission(...)` when a plugin starts work on a persisted session. The callback rejects archived or concurrently replaced sessions, keeps archive/reset/delete mutations coordinated through completion, and receives an `AbortSignal` that must be forwarded to the agent run. A harness may explicitly name trusted execution delegates through its experimental `delegatedExecutionPluginIds` registration field. Delegates can admit and run only an exact existing model-locked session; all session mutations remain restricted to the harness owner. See [Agent harness plugins](/plugins/sdk-agent-harness#delegated-execution).

    Maintenance and repair plugins may use `deleteSessionEntry(...)` for one scoped session entry, `cleanupSessionLifecycleArtifacts(...)` for lifecycle-owned scratch sessions, and `resolveSessionStoreBackupPaths(...)` before mutating a store. Pass `expectedSessionId` and `expectedUpdatedAt` when deletion must not race a concurrent session update; use `expectedSessionId: null` when the earlier snapshot had no session id. These helpers are narrow repair/lifecycle surfaces, not a general store deletion API.

    `resolveStorePath(...)` and `updateSessionStoreEntry(...)` round out the session helpers: `resolveStorePath` resolves the session store path for a given scope, and `updateSessionStoreEntry({ storePath, sessionKey, update })` patches one entry directly by store path when the caller already knows it.

    `loadTranscriptEventsSync(...)` is available for synchronous doctor and repair paths that cannot use the async transcript runtime. It returns raw `SessionStoreTranscriptEvent` records and does not consult runtime `session.store`; pass `storePath` for a non-default store. Normal plugin runtime code should prefer `openclaw/plugin-sdk/session-transcript-runtime`.

    `formatSqliteSessionFileMarker(...)`, `parseSqliteSessionFileMarker(...)`, and `sqliteSessionFileMarkerMatchesSession(...)` are transitional helpers for code that still receives a legacy field named `sessionFile`. A parsed SQLite marker identifies a live SQLite transcript target; it is not a filesystem path. New APIs should carry typed session identity instead of marker strings.

    For transcript reads and writes, import `openclaw/plugin-sdk/session-transcript-runtime` and use `resolveSessionTranscriptIdentity(...)`, `resolveSessionTranscriptTarget(...)`, `readSessionTranscriptEvents(...)`, `readSessionTranscriptRawDelta(...)`, `readSessionTranscriptVisibleMessageDelta(...)`, `readVisibleSessionTranscriptMessageEntries(...)`, `appendSessionTranscriptMessageByIdentity(...)`, `publishSessionTranscriptUpdateByIdentity(...)`, or `withSessionTranscriptWriteLock(...)` with `{ agentId, sessionKey, sessionId }`. These APIs let plugins identify a transcript, read raw events or visible branch-safe message entries, append messages, publish updates, and run related operations under the same transcript write lock without depending on active transcript file paths. `readVisibleSessionTranscriptMessageEntries(...)` returns ordered read metadata; its `seq` field is not a resumable cursor.

    For the identity-based operations listed above, an omitted `storePath` selects `session.store` from the supplied `config` when the operation accepts one, otherwise from the current runtime config snapshot. An explicit concrete `storePath` takes precedence; incognito session keys always select isolated in-memory storage. The write lock pins its selected store for callback reads, appends, and queued publication, even if runtime config changes while the callback awaits. Public identities and targets remain pathless. `readLatestAssistantTextByIdentity(...)` and `appendAssistantMirrorMessageByIdentity(...)` use the same store-selection rules.

    `readLatestAssistantTextByIdentity(...)` preserves the selected assistant text's whitespace and includes optional validated `openclawDelivery` facts from that same persisted message. Recovery consumers can retain reply, voice, media, and TTS intent without reparsing removed directives. These facts do not grant delivery authority; callers still apply their current-turn and reply-policy checks.

    `withSessionTranscriptWrite(...)` exposes `readMessageFacts({ idempotencyKeys })` for exact-key lookups without loading the complete transcript. Facts and writes retain the context’s captured session and store; retained callbacks reject after the context closes. Native-history repair can preserve an existing message’s original run attribution while leaving the append owner’s strict payload comparison intact. A returned identity is evidence, not new execution authority.

    `appendSessionTranscriptMessageByIdentity(...)` is a low-level append of an already canonical message. Plugins must not synthesize media-bearing user rows with top-level `MediaPath`, `MediaPaths`, `MediaUrl`, `MediaUrls`, `MediaType`, or `MediaTypes`. Channel ingress should pass ordered facts through `MsgContext.media` and let the host own user-turn persistence. A host-prepared persisted user message carries canonical ordered facts under `message.__openclaw.media`; the generic append API does not infer or repair legacy parallel arrays.

    A harness that supports `sessions_yield` uses `appendSessionYieldContext(...)` after successful yield settlement to retain private resume context in the canonical session transcript. Pass the session target, `message`, and an `assertCurrent` callback that checks the current run and settlement authority. The writer checks that callback again before appending the hidden context entry. Failed or revoked settlement must not append context; public tool results and display projections must omit the private message.

Read-only native session catalogs use `readSessionTranscriptCatalogPage({ agentId, sessionKey, storePath?, limit, cursor, sourceDomain, pluginId })` from the same subpath. It returns `{ items, nextCursor? }` in newest-first catalog order; the optional opaque cursor continues toward older items and malformed cursors are rejected. The reader resolves the configured session store when `storePath` is omitted and binds the cursor to the selected store and session. Only nonempty user and assistant text from the local chat display projection is included; tool calls, tool results, reasoning, and other non-conversation blocks are omitted. Text redacts credential patterns and is bounded per item with `truncated` set when clipped. Reads scan at most 1,000 source messages per page, so a page containing only omitted activity can have no items and still return a continuation cursor. Cursors from the earlier tool-inclusive projection are rejected with a reload message. Raw page reads are bounded to 8 MiB; an oversized entry returns an explicit error. Cold history requires restoration by the source Gateway; the catalog reader never opens a writer to restore it. User sender attribution is portable: source-local profiles become remote identities in the caller's plugin/domain namespace, using a verified numeric GitHub account ID when available and a source profile ID otherwise. Existing remote and observed identities remain portable. The caller must authorize each session read separately; a cursor or identity claim never grants access. [Session Share](/plugins/session-share) uses this reader for its paired-node publication.

Catalog list publishers use `createSessionCatalogSourceActorProjector({ pluginId, sourceDomain, actors })` from the same subpath after selecting a page. Call the returned function for each actor in that page, synchronously and in publication order. It shares profile and verified GitHub reads while keeping each actor's label. Only human creators stamped with `source: "profile"` resolve local profiles; the resulting remote claims never grant access. Create a new projector for each page or request so profile merges, display names, and primary GitHub accounts are refreshed.

    A harness host may provide `hostCapabilities.prepareContextMedia({ message, maxChars })` to reconstruct retained document text and images from canonical user media. The host captures the current run's config, workspace, channel, account, and authority; preparation rechecks that authority across asynchronous work. `maxChars` must be finite and limits extraction for each file. Fit all returned text, attachment notes, and images into the native context budget, and deliver image bytes through the native input path. Preparation reuses ordinary local-root, URL, MIME, byte, page, and image limits without rewriting transcript rows or echoing channel media. An older host without this optional capability may still project ordinary text history, but attachment restoration must fail explicitly rather than silently omit the saved input.

    For an exact existing session, use `appendSessionTranscriptMessageByIdentityStrict(...)` for one message or `appendSessionTranscriptMessagesByIdentity(...)` for an atomic ordered batch. Both accept optional `storePath`: when omitted, the shared turn owner resolves it from the supplied `config` (or current runtime snapshot), session agent, and `env`; an explicit concrete path overrides `session.store`, while incognito keys retain their in-memory routing. Strict single append returns `kind: "result"`, `kind: "suppressed"` when message preparation declines the append, or `{ kind: "rejected", reason: "session-rebound" }` when the expected session no longer matches. A batch rejects if its session changed and inserts or idempotently replays the whole group, never a partial group.

    A harness host may provide `hostCapabilities.annotateCurrentUserTurn(...)` for its already-admitted current prompt. The operation accepts only `mirrorIdentity`, `upstreamUserText`, `mirrorOrigin`, and `mirrorSourceFingerprint`; the host fixes diagnostic run correlation. Call it only after native prompt acceptance and outside transcript write locks. It cannot select an anchor, replace content, or annotate history. It revalidates the live host, exact recorder, active admission, session/writer ownership, unchanged message and source fingerprint at commit, then refreshes the recorder's generation and publishes the same event ID. Identical provenance does not rewrite or publish again. Missing capability, conflicts and stale owners must remain refusals; do not substitute a generic append or infer provenance. This optional capability adds no required host-version field and does not change transcript cursor invalidation.

    The host owns annotation eligibility. Hidden prompts that participate in model context can receive this capability; context-excluded prompts cannot. A harness reuses an admitted prompt's persisted message and receipt instead of appending its own copy, both at native turn start and settlement. If annotation is unavailable, leave the host row unchanged; if it disappears, do not recreate it from the native transcript.

    `readSessionTranscriptRawDelta(...)` returns a bounded `page`, `reset`, or `missing` result. Pass the opaque `page.cursor` into the next call. Pure appends preserve the cursor, while transcript replacement returns `reset` with a new bootstrap cursor. Pages default to 1,000 events and 1,000,000 serialized bytes; callers may request up to 10,000 events and 64 MiB. When the next event alone exceeds `maxBytes`, the page is empty and reports `requiredBytes`; retry with at least that byte limit when it is no greater than 64 MiB. Larger individual events require the complete-read API. A cursor identifies position only and never grants access to another session.

    `readSessionTranscriptVisibleMessageDelta(...)` provides the same bounded bootstrap-and-resume shape over the host-owned active message projection. It returns messages from oldest to newest, so context engines can drain initial history and persist the opaque cursor as their watermark. Store and return the cursor unchanged; it is a continuation hint, not an authorization credential. Linear appends resume after the last returned message. Transcript replacement, a cursor whose anchor left or moved within the active branch, malformed cursors, and cross-session cursors return `reset` with a fresh bootstrap cursor. The count and byte defaults and caps match the raw delta API. While the active projection is rebuilding after a branch change, the result is `unavailable` with reason `projection_rebuilding`; retry later rather than falling back to an active transcript file.

    Entries from `readVisibleSessionTranscriptMessageEntries(...)` and `readSessionTranscriptVisibleMessageDelta(...)` include an optional `supersedesEntryId` only when a transcript rewrite re-appended that message. A rewrite (tool-result truncation, chat edits, or `rewriteTranscriptEntries()`) copies the active suffix under new entry ids, so a stored cursor whose anchor was replaced returns `reset` with reason `anchor_missing`. After rebootstrapping, map each copy to its previous entry through `supersedesEntryId` instead of matching content. The value is the immediately replaced entry id; repeated rewrites form a chain. Plain appends and messages re-appended by rewrites made before this field existed have no marker.

    The beta.5 whole-store and transcript-path bridge has been removed from `openclaw/plugin-sdk/session-store-runtime`, along with the package-root `loadSessionStore` and `saveSessionStore` aliases. The September 30, 2026 approved [supported-plugin cutoff](/plugins/compatibility#session-store-bridge-retirement) excludes `v2026.7.1-beta.5` and other releases still importing that bridge. The subpath, scoped entry helpers, and `resolveStorePath(...)` remain available. Pass `agentId` to row operations explicitly; path resolution does not select an agent for later calls.

    Use the scoped entry helpers for session metadata and the transcript identity helpers for active transcript operations. Archive/support workflows that need file artifacts should use their dedicated archive surfaces instead of active session runtime APIs. SQLite remains canonical, and existing legacy-state import and Doctor migrations remain available.

  </Accordion>
  <Accordion title="api.runtime.agent.defaults">
    Default model and provider constants:

    ```typescript
    const model = api.runtime.agent.defaults.model; // e.g. "gpt-6-astra"
    const provider = api.runtime.agent.defaults.provider; // e.g. "openai"
    ```

  </Accordion>
  <Accordion title="api.runtime.worktrees">
    Managed worktree creation, release, and lossless removal retain the selected
    state root's ownership through their Git and registry effects. Calls inside
    the owning Gateway stay in-process. When no process owns the state, these
    methods acquire exclusive offline custody and release it after accepted
    work settles.

    A foreign live Gateway or embedded owner rejects these mutations with
    `code: "OWNER_UNAVAILABLE"` before local effects. Run the plugin operation
    inside the owning Gateway, or stop the Gateway through its service owner
    and wait for embedded runs to finish before retrying offline. The SDK's
    synchronous commit guard for `create` remains local and cannot cross RPC.
    Checkout-root and metadata inspection remain read-only. Method signatures
    are unchanged; no migration is required.

  </Accordion>
  <Accordion title="api.runtime.sandbox">
    Inspect the effective sandbox workspace authority for an agent session.

    ```typescript
    const authority = api.runtime.sandbox.resolveWorkspaceAuthority({
      config: cfg,
      agentId,
      sessionKey,
    });

    const liveAuthority = await api.runtime.sandbox.prepareWorkspaceAuthority({
      config: cfg,
      agentId,
      sessionKey,
      workspaceDir,
      confinedToolNames: ["my_plugin_safe_tool"],
    });
    ```

    The result reports whether this session is sandboxed, whether its workspace
    is unavailable, read-only, or writable, and an optional `confinementError`
    when the effective Docker, tool, session, browser, or elevated policy can
    escape that workspace. Use this for host-owned delegation decisions that
    must not grant a worker more authority than its caller. It is an attestation
    helper, not a replacement for checking the caller's own authorization.

    `prepareWorkspaceAuthority(...)` performs the same policy check and also
    prepares the Docker sandbox for `workspaceDir`. It rejects a hot container
    whose live config hash does not match the requested mounts or policy. Pass
    only exact tool names whose registered implementations the calling plugin
    confines; wildcard prefixes do not prove tool ownership.

    Sandbox workspace preparation checks the selected state root's live owner.
    This applies to
    `prepareWorkspaceAuthority(...)` and `resolveSandboxContext(...)` from
    `openclaw/plugin-sdk/agent-harness-runtime`. Disabled sandbox resolution stays
    a no-op, and read-only session classification remains available in foreign
    processes. When sandboxing is enabled, a foreign live Gateway or embedded
    owner causes `code: "GATEWAY_STATE_OWNER_REQUIRED"` before sandbox workspace,
    registry, or projection mutation. Run the call inside the owning Gateway
    plugin/runtime, or stop the Gateway and wait for embedded runs to finish,
    then retry offline.

    Calls hosted by the current Gateway or embedded owner stay in-process.
    Preparation rechecks captured custody before workspace setup and backend
    provisioning. Losing that custody rejects with `GATEWAY_STATE_OWNER_REQUIRED`;
    built-in container backends also retain the check across provisioning awaits.
    Standalone SDK callers also stay local when no live owner exists. Preparation
    does not acquire a temporary lock or forward permission callbacks over RPC;
    it does not prevent another owner from starting after offline admission.
    Released parameters and return types are unchanged. Older SDK binaries and
    other state roots remain outside this same-root gate; database freshness
    checks still apply. No migration or update step is required.

  </Accordion>
</AccordionGroup>
