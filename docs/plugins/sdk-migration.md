---
summary: "Migrate from the legacy backwards-compatibility layer to the modern plugin SDK"
title: "Plugin SDK migration"
sidebarTitle: "Migrate to SDK"
read_when:
  - You used api.registerEmbeddedExtensionFactory before OpenClaw 2026.4.25
  - You are updating a plugin to the modern plugin architecture
  - You maintain an external OpenClaw plugin
---

OpenClaw replaced a broad backwards-compatibility layer with a modern plugin
architecture built from small, focused imports. If your plugin predates that
change, this guide gets it onto the current contracts.

For synchronous SQLite APIs, use the [complete async migration
guide](/plugins/sdk-migration/sqlite-async). The final compatibility day is
**2026-12-31**; removal ships in the **first January 2027 stable release**, without
a Plugin SDK major version. The tables cover every affected member and its
awaited or prepared replacement.

## MCP result compatibility window

OpenClaw's session and node MCP clients use the split MCP SDK v2 packages while
continuing to negotiate legacy MCP. The published plugin boundary retains its
MCP SDK v1 result shapes for one stable-release window: the first stable release
containing this migration. Replacing those shapes with v2 types is scheduled for
the following stable release; no calendar date is assigned yet.

The affected contracts are `SessionMcpRuntime.callTool`, `listTools`,
`listResourceTemplates`, and `getPrompt` from
`openclaw/plugin-sdk/agent-harness-runtime`, its
`prepareHarnessNativeMcpAppPreview.toolResult` input, and the runtime accepted by
`openclaw/plugin-sdk/codex-mcp-projection`. Keep the existing v1 types when
implementing these adapters during the compatibility window. Ordinary plugins
that register tools or MCP connection resolvers do not need a new dependency.

Host results cross this boundary losslessly. An incompatible result throws an
error with `code: "MCP_SDK_RESULT_UNREPRESENTABLE"` and the MCP method name rather
than dropping fields. This includes non-object `structuredContent` (arrays,
scalars, or null), output schemas without `type: "object"`, non-object
`properties` or non-string-array `required` in an output schema, scalar or null
values in a tool's input/output schema `properties`, and nested fields that the
v1 result schemas would discard.
Metadata, resource content, prompt messages, and pagination cursors are preserved
when representable.

When the next stable release adopts v2 result types, import result and client
types from `@modelcontextprotocol/client`, schema validators from
`@modelcontextprotocol/core`, and the AJV adapter from
`@modelcontextprotocol/client/validators/ajv`. Treat `structuredContent` as
`unknown` and narrow it before reading properties; preserve JSON Schema values
without assuming every property schema is an object. For example:

```ts
import type { CallToolResult } from "@modelcontextprotocol/client";

function readSummary(result: CallToolResult): string | undefined {
  const value = result.structuredContent;
  if (value && typeof value === "object" && "summary" in value) {
    return typeof value.summary === "string" ? value.summary : undefined;
  }
  return undefined;
}
```

The compatibility window does not enable modern protocol serving or change MCP
server configuration.

## What changed

Several wide-open import surfaces used to let plugins reach almost anything
from a single entry point:

- **`openclaw/plugin-sdk`** and **`openclaw/plugin-sdk/compat`** - re-exported
  dozens of helpers while the focused SDK was being built. Both roots are now
  removed. Import a documented subpath instead.
- **`openclaw/plugin-sdk/infra-runtime`** - a broad barrel mixing system
  events, heartbeat state, delivery queues, fetch/proxy helpers, file helpers,
  approval types, and unrelated utilities.
- **`openclaw/plugin-sdk/config-runtime`** - a removed broad config barrel,
  including its deprecated direct `loadConfig` and `writeConfigFile` exports.
- **`openclaw/plugin-sdk/channel-lifecycle`**, **`channel-message`**, and
  **`channel-reply-pipeline`** - removed channel compatibility facades. Use
  the focused outbound and inbound contracts, checking each named export.
- **`openclaw/extension-api`** - a removed bridge that gave plugins direct
  access to host-side helpers like the embedded agent runner.
- **`api.registerEmbeddedExtensionFactory(...)`** - a removed embedded-runner-only
  hook that observed embedded-runner events such as `tool_result`. Use agent
  tool-result middleware instead (see [Migrate embedded tool-result extensions
  to middleware](/plugins/sdk-migration/how-to-migrate#how-to-migrate)).

The root SDK, compat barrel, extension bridge, embedded extension factory, and
five channel/config/infrastructure compatibility facades have been removed.
The latter retirement received explicit SDK-owner approval on September 30,
2026; see the [removal timeline](/plugins/sdk-migration/removal-timeline).

<Warning>
  Plugins importing the removed SDK or extension surfaces no longer
  load. Follow the [import path mappings](/plugins/sdk-migration/import-paths) before upgrading.
</Warning>

OpenClaw's default compatibility policy preserves documented plugin behavior
through a compatibility adapter, diagnostics, docs, and a deprecation window.
That applies to SDK imports, manifest fields, setup APIs, hooks, and runtime
registration behavior. The three session-controller changes below are explicit
exceptions with immediate enforcement and no compatibility aliases or window.

`ChatCommandDefinition.category` retains the `"docks"` value accepted by the
2026.8.1 SDK. Command lists display these legacy definitions under **Tools**.
The category does not enable channel docking or restore retired docking commands.
New definitions should use `"tools"`.

Bundled ACP integrations should await `readAcpSessionEntryAsync` from the local
`openclaw/plugin-sdk/acp-runtime` facade for session metadata reads. This facade
remains a JavaScript compatibility export; its declarations are excluded from
the typed public SDK. File-backed reads run on the SQLite workers and preserve the session lifecycle throughout the
metadata join. File-backed results are detached snapshots, including when
`clone: false` is supplied. The returned `storeReadFailed` flag still distinguishes an
unreadable session store from missing metadata; startup cleanup must keep
bindings when that flag is set. Unbound legacy ACP metadata can still accompany
that flag; it does not certify the session row. Source retirement and worker failures reject
the read and must not be treated as an absent session.

The synchronous `readAcpSessionEntry` and
`getAcpSessionManager().resolveSession()` contracts shipped in `v2026.9.4`
remain available for durable sessions and are deprecated for runtime use.
Incognito targets reject synchronous access with `IncognitoSessionSyncAccessError`;
use `readAcpSessionEntryAsync` and
`getAcpSessionManager().resolveSessionAsync()` instead. The asynchronous path
acquires the existing memory session actor and joins global ACP metadata through
the shared-state worker. It does not create a missing incognito session.

Discord and Telegram startup cleanup use `prepareAcpSessionEntryRead` for
incognito targets. Its prepared reader retains the selected memory owner and
carries current caller authority through conditional binding deletion. Closing
the session ends that authority; cleanup does not reopen the retired native
incognito database.

`IncognitoSessionEndedError` and `IncognitoSessionSyncAccessError`, exposed through
the local `openclaw/plugin-sdk/acp-runtime` facade, must propagate through cleanup and status
probes. Use `rethrowIncognitoSessionError(error)` before treating other failures
as an absent session or an uncertain probe; it also recognizes nested refusals.
The deprecated synchronous contracts for durable sessions remain available
through 2026-12-31 and are removed in the first January 2027 stable release.

### Session-keyed harness registration

The session-controller cutover changes standalone session-keyed
`setActiveEmbeddedRun(...)` registration immediately, with no compatibility
window. Register native runs from the host-provided, admitted harness attempt.
Calling the function without that admission throws
`AgentHarnessPreflightError`, with code
`SESSION_CONTROLLER_ADMISSION_REQUIRED` and migration guidance.

A hosted call inherits the host's captured operation; passing a session key,
agent ID, or a plugin-created operation does not obtain admission. Host-owned
detached work can carry a session key for policy, but cannot own that session's
turn, queue, or Stop. See [Harness attempt runtime](/plugins/sdk-agent-harness/attempt-runtime)
for the supported registration and cleanup path. Registration accepts only the
five public identity arguments and returns a cleanup function bound to that
exact run. The optional `replyOperation` refers to the same admitted controller
and retains its documented tool-authority methods; it does not authorize
standalone registration. Host admission state and native attachment records
stay private to the host.

### Gateway session control

`GatewayRequestHandlerOptions.context` no longer exposes the mutable
`chatAbortControllers` or `chatQueuedTurns` maps. The session controller owns
admission, queued input, and Stop; plugin handlers cannot register or cancel work
by changing shared maps. Reading either removed property fails with code
`PLUGIN_CAPABILITY_REMOVED` and the exact capability name.

Keep `api.registerGatewayMethod(...)` for plugin methods. To compose existing
session operations from an authenticated handler, declare
`contracts: { gatewayMethodDispatch: ["authenticated-request"] }` in the plugin
manifest and import `dispatchGatewayMethod` from
`openclaw/plugin-sdk/gateway-method-runtime`. Use `chat.send` to submit input,
`chat.abort` with `{ sessionKey, runId? }` to cancel a chat run, or
`sessions.abort` with `{ key, runId?, clearQueued? }` for session cancellation.
These calls retain the current caller's authority and the target method's
authorization; the declaration does not grant additional scopes. Use
`agent.wait` to await a run, and `sessions.list` for activity observations.
Bundled or trusted official plugins can also use `api.runtime.gateway.request`,
session facts, and subscriptions; those runtime capabilities retain their
existing trust restriction.
See [Gateway runtime](/plugins/sdk-runtime/gateway-and-nodes#session-control)
for the supported read and control paths.

### Agent turn start observation

`AgentTurnStartOwner.observe()` now returns `startDeadlineAtMs` instead of
`expiresAtMs`. The old property has no alias; reading it fails with code
`PLUGIN_CAPABILITY_REMOVED`. Update consumers of the `onStartOwner` callback
exposed through `context.createAgentTurnFacade` to inspect the new field.

A finite `startDeadlineAtMs` is the controller's deadline for execution to
start. `null` means a live controller-owned wait has no finite start deadline;
an absent field means no controller deadline is available yet. An `undefined`
observation means the captured owner is no longer current. Stop watching for
start once `executionStarted` is true. This field does not extend execution
authority or describe the run's execution timeout. Other API fields named
`expiresAtMs` retain their existing contracts.

### Session and command preparation

Use `getSessionEntryAsync`, `readSessionUpdatedAtAsync`,
`getConversationSessionAsync`, `readAmbientTranscriptWatermarkAsync`,
`loadTranscriptEvents`, and `readTranscriptStatsAsync` from
`openclaw/plugin-sdk/session-store-runtime` for ordinary session reads. The
runtime equivalent is `api.runtime.agent.session.getSessionEntryAsync`. These
operations read through the existing session worker and observe committed
in-process writes. Missing entries remain `undefined`; read failures propagate.
`loadTranscriptEventsSync` and `readTranscriptStatsSync` are deprecated; their
awaited replacements preserve ordered events and transcript statistics while
keeping durable reads off the Gateway thread.

Await `UserTurnTranscriptRecorder.completeProcessingAsync(outcome)` to settle an
accepted input through its session owner. The deprecated `completeProcessing`
method preserves synchronous completion and returns after the terminal outcome
commits, with a migration warning, through 2026-12-31. Recorders
without an accepted input keep their existing no-op behavior.

Use `readSessionTranscriptCatalogTitleAsync` from
`openclaw/plugin-sdk/session-transcript-runtime` for catalog titles. The
synchronous `readSessionTranscriptCatalogTitle` remains deprecated through
2026-12-31.

Use `resolveStoredModelOverrideAsync` and `resolveCommandArgMenuAsync` from
`openclaw/plugin-sdk/command-auth-native` when preparing native commands.
`resolveCommandArgMenuAsync` is also exported by
`openclaw/plugin-sdk/native-command-registry`. An inherited-model loader may
return a promise; direct overrides still need no parent read. Menu preparation
reads the current session's verbose setting before returning its choices.

The corresponding synchronous APIs are deprecated for ordinary runtime use.
Released signatures remain supported through 2026-12-31. New
legacy calls emit a bounded deprecation warning. Bundled callers use the awaited
operations; final tool, disclosure, and mutation authority checks retain their
current owner and timing.

For a complete cross-session store view, await
`loadCombinedSessionStoreForGatewayAsync` from
`openclaw/plugin-sdk/session-transcript-hit`. It preserves full session entries
and excludes incognito sessions while reading durable stores through the existing
database worker. The synchronous `loadCombinedSessionStoreForGateway` retains its
return value and emits a bounded deprecation warning; it remains supported through
2026-12-31.

### Native session lineage

Use `resolvePreparedNativeSessionBinding` or
`retainNativeSessionGenerationAuthority` from
`openclaw/plugin-sdk/agent-harness-session-runtime` to prepare lineage in the
session worker. Both return an owned capture: call `release()` in `finally`
after the last effect and any terminal cleanup. Repeated authority checks use
the session owner's published facts and immediately reject revoked lineage.

Use `authority.withLiveness(assertCurrent)` when cleanup needs its own lifecycle
check. This borrows the same source; it does not extend the capture's lifetime.
Use `createNativeSessionBindingScope` when there is no stored session lineage.
The released `createNativeSessionBindingAuthority`,
`combineNativeSessionBindingAuthority`, `prepareNativeSessionGenerationAuthority`,
and `resolveNativeSessionBindingWithAuthority` contracts remain available but
deprecated. Their synchronous readers are compatibility paths; bundled harnesses
use the prepared API.

### Exec approval reads

Await `loadExecApprovalsReadOnlyAsync` or `readExecApprovalsSnapshotAsync` from
`openclaw/plugin-sdk/exec-approvals-runtime`. Both use the existing shared-state
read worker. The synchronous `loadExecApprovals` and `readExecApprovalsSnapshot`
exports retain their signatures through 2026-12-31, emit a bounded
deprecation warning, and are scheduled for removal in the first January 2027 stable release. Bundled
runtime callers use the awaited reads. The execution owner still checks current
approval policy immediately before command execution using committed in-process
policy publications; that final check does not query SQLite.

### Session reset freshness

Channel runtime consumers should await
`runtime.channel.session.resolveEntryResetFreshnessAsync(...)` when deciding
whether a session needs reset. File-backed entries and transcript lifecycle
timestamps are read from the same worker snapshot, with the original database
owner retained through validation and cleanup. The synchronous
`resolveEntryResetFreshness(...)` method shipped in `v2026.9.8` remains available
for existing JavaScript consumers and is deprecated for runtime use; removal
ships in the first January 2027 stable release after the 2026-12-31 compatibility cutoff. Both methods retain the
existing reset policy and process-held incognito behavior.

### Why

- **Slow startup** - importing one helper loaded dozens of unrelated modules.
- **Circular dependencies** - broad re-exports made import cycles easy to
  create.
- **Unclear API surface** - no way to tell stable exports from internal ones.

The typed public SDK is organized into focused subpaths with documented
contracts. Not every SDK build entrypoint is a public plugin API.

Legacy provider convenience interfaces for bundled channels are gone too -
channel-branded helper shortcuts were private mono-repo conveniences, not
stable plugin contracts. Use narrow generic SDK subpaths instead. Inside the
bundled plugin workspace, keep provider-owned helpers in that plugin's own
`api.ts` or `runtime-api.ts`:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` interface.
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`.
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`.

## Where each topic lives

Every section of the single-page version lives on one of the six pages below.
The anchors from the single-page version still resolve here.

### Migration steps

[How to migrate a plugin](/plugins/sdk-migration/how-to-migrate) — the ordered migration steps.

- [Await personal model-account operations](/plugins/sdk-migration/how-to-migrate#await-personal-model-account-operations)
- [Await session transcript persistence](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence)
- [Await extension session changes](/plugins/sdk-migration/how-to-migrate#await-extension-session-changes)
- [Await provider replay metadata](/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata)
- <a id="how-to-migrate"></a>[How to migrate](/plugins/sdk-migration/how-to-migrate#how-to-migrate)
- <a id="migrate-runtime-config-load%2Fwrite-helpers"></a>[Migrate runtime config load/write helpers](/plugins/sdk-migration/how-to-migrate#migrate-runtime-config-load%2Fwrite-helpers)
- <a id="migrate-embedded-tool-result-extensions-to-middleware"></a>[Migrate embedded tool-result extensions to middleware](/plugins/sdk-migration/how-to-migrate#migrate-embedded-tool-result-extensions-to-middleware)
- <a id="migrate-approval-native-handlers-to-capability-facts"></a>[Migrate approval-native handlers to capability facts](/plugins/sdk-migration/how-to-migrate#migrate-approval-native-handlers-to-capability-facts)
- <a id="audit-windows-wrapper-fallback-behavior"></a>[Audit Windows wrapper fallback behavior](/plugins/sdk-migration/how-to-migrate#audit-windows-wrapper-fallback-behavior)
- <a id="find-deprecated-imports"></a>[Find deprecated imports](/plugins/sdk-migration/how-to-migrate#find-deprecated-imports)
- <a id="replace-with-focused-imports"></a>[Replace with focused imports](/plugins/sdk-migration/how-to-migrate#replace-with-focused-imports)
- <a id="replace-broad-infra-runtime-imports"></a>[Replace broad `infra-runtime` imports](/plugins/sdk-migration/how-to-migrate#replace-broad-infra-runtime-imports)
- <a id="migrate-channel-route-helpers"></a>[Migrate channel route helpers](/plugins/sdk-migration/how-to-migrate#migrate-channel-route-helpers)
- <a id="build-and-test"></a>[Build and test](/plugins/sdk-migration/how-to-migrate#build-and-test)

### Import paths

[Import path reference](/plugins/sdk-migration/import-paths) — which typed-public subpath replaces each legacy import.

- <a id="import-path-reference"></a>[Import path reference](/plugins/sdk-migration/import-paths#import-path-reference)
- <a id="retained-channel-facade-mappings"></a>[Removed channel facade mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)

### Removed surfaces and replacements

[Removed surfaces and replacements](/plugins/sdk-migration/removed-surfaces) — what was removed, and the replacement for each legacy API.

- [Heartbeat executor and wake helpers](/plugins/sdk-migration/removed-surfaces#heartbeat-executor-and-wake-helpers)
- <a id="removed-compatibility-surfaces"></a>[Removed compatibility surfaces](/plugins/sdk-migration/removed-surfaces#removed-compatibility-surfaces)
- <a id="process-global-api-provider-publication"></a>[Process-global API-provider publication](/plugins/sdk-migration/removed-surfaces#process-global-api-provider-publication)
- <a id="deactivate-hook-alias"></a>[Deactivate hook alias](/plugins/sdk-migration/removed-surfaces#deactivate-hook-alias)
- <a id="private-testing-barrel"></a>[Private testing barrel](/plugins/sdk-migration/removed-surfaces#private-testing-barrel)
- <a id="migration-reference"></a>[Migration reference](/plugins/sdk-migration/removed-surfaces#migration-reference)
- <a id="command-auth"></a>[`command-auth` help builders -> `command-status`](/plugins/sdk-migration/removed-surfaces#command-auth-help-builders-command-status)
- <a id="mention"></a>[Mention gating helpers -> `resolveInboundMentionDecision`](/plugins/sdk-migration/removed-surfaces#mention-gating-helpers-resolveinboundmentiondecision)
- <a id="channel-runtime-shim-and-channel-actions-helpers"></a>[Channel runtime shim and channel actions helpers](/plugins/sdk-migration/removed-surfaces#channel-runtime-shim-and-channel-actions-helpers)
- <a id="web"></a>[Web search provider `tool()` helper -> `createTool()` on the plugin](/plugins/sdk-migration/removed-surfaces#web-search-provider-tool-helper-createtool-on-the-plugin)
- <a id="plaintext"></a>[Plaintext channel envelopes -> `BodyForAgent`](/plugins/sdk-migration/removed-surfaces#plaintext-channel-envelopes-bodyforagent)
- <a id="subagent-spawning"></a>[`subagent_spawning` hook -> core thread binding](/plugins/sdk-migration/removed-surfaces#subagent-spawning-hook-core-thread-binding)
- <a id="provider"></a>[Provider discovery types -> provider catalog types](/plugins/sdk-migration/removed-surfaces#provider-discovery-types-provider-catalog-types)
- <a id="thinking"></a>[Thinking policy hooks -> `resolveThinkingProfile`](/plugins/sdk-migration/removed-surfaces#thinking-policy-hooks-resolvethinkingprofile)
- <a id="external"></a>[External auth providers -> `contracts.externalAuthProviders`](/plugins/sdk-migration/removed-surfaces#external-auth-providers-contracts-externalauthproviders)
- <a id="provider-1"></a>[Provider env-var lookup -> `setup.providers[].envVars`](/plugins/sdk-migration/removed-surfaces#provider-env-var-lookup-setup-providers-envvars)
- <a id="memory"></a>[Memory plugin registration -> `registerMemoryCapability`](/plugins/sdk-migration/removed-surfaces#memory-plugin-registration-registermemorycapability)
- <a id="memory-embedding-provider-api"></a>[Memory embedding provider API](/plugins/sdk-migration/removed-surfaces#memory-embedding-provider-api)
- <a id="raw"></a>[Raw channel send results -> `OutboundDeliveryResult`](/plugins/sdk-migration/removed-surfaces#raw-channel-send-results-outbounddeliveryresult)
- <a id="subagent-session-messages-types-renamed"></a>[Subagent session messages types renamed](/plugins/sdk-migration/removed-surfaces#subagent-session-messages-types-renamed)
- <a id="removed-session-and-transcript-file-apis"></a>[Removed session and transcript file APIs](/plugins/sdk-migration/removed-surfaces#removed-session-and-transcript-file-apis)
- <a id="agent"></a>[Agent harness attempt params -> V2 host-capability contract](/plugins/sdk-migration/removed-surfaces#agent-harness-attempt-params-v2-host-capability-contract)
- <a id="embedded"></a>[Embedded extension factories -> agent tool-result middleware](/plugins/sdk-migration/removed-surfaces#embedded-extension-factories-agent-tool-result-middleware)
- <a id="openclawschematype"></a>[`OpenClawSchemaType` alias -> `OpenClawConfig`](/plugins/sdk-migration/removed-surfaces#openclawschematype-alias-openclawconfig)

### Talk and voice

[Talk and realtime voice migration](/plugins/sdk-migration/talk) — the unified Talk session API and its method map.

- <a id="talk-and-realtime-voice-migration"></a>[Talk and realtime voice migration](/plugins/sdk-migration/talk#talk-and-realtime-voice-migration)

### Compatibility records

[Compatibility policy and records](/plugins/sdk-migration/compatibility-policy) — what is retained, why, and on what condition it can be removed.

- <a id="compatibility-policy"></a>[Compatibility policy](/plugins/sdk-migration/compatibility-policy#compatibility-policy)
- <a id="retained-helper-contracts"></a>[Retained helper contracts](/plugins/sdk-migration/compatibility-policy#retained-helper-contracts)
- <a id="harness-attempt-result-migration"></a>[Harness attempt result migration](/plugins/sdk-migration/compatibility-policy#harness-attempt-result-migration)
- <a id="model-provider-result-compatibility"></a>[Model-provider result compatibility](/plugins/sdk-migration/compatibility-policy#model-provider-result-compatibility)
- <a id="memory-read-missing-results"></a>[Memory read missing results](/plugins/sdk-migration/compatibility-policy#memory-read-missing-results)
- <a id="config-record-migrations"></a>[Config record migrations](/plugins/sdk-migration/compatibility-policy#config-record-migrations)
- <a id="plugin-state-migration-declarations"></a>[Plugin state migration declarations](/plugins/sdk-migration/compatibility-policy#plugin-state-migration-declarations)
- <a id="authstorage-sqlite-migration"></a>[AuthStorage SQLite migration](/plugins/sdk-migration/compatibility-policy#authstorage-sqlite-migration)
- <a id="published-channel-setup-compatibility"></a>[Published channel setup compatibility](/plugins/sdk-migration/compatibility-policy#published-channel-setup-compatibility)
- <a id="channel-setup-input-field-compatibility"></a>[Channel setup input field compatibility](/plugins/sdk-migration/compatibility-policy#channel-setup-input-field-compatibility)
- <a id="verifying-readers"></a>[Verifying readers](/plugins/sdk-migration/compatibility-policy#verifying-readers)
- <a id="media-legacy-projection"></a>[Media legacy projection](/plugins/sdk-migration/compatibility-policy#media-legacy-projection)

### Timeline

[Removal timeline](/plugins/sdk-migration/removal-timeline) — when deprecated surfaces become eligible for removal.

- <a id="removal-timeline"></a>[Removal timeline](/plugins/sdk-migration/removal-timeline#removal-timeline)

## Related

- [Getting Started](/plugins/building-plugins) - build your first plugin
- [SDK Overview](/plugins/sdk-overview) - full subpath import reference
- [Channel Plugins](/plugins/sdk-channel-plugins) - building channel plugins
- [Provider Plugins](/plugins/sdk-provider-plugins) - building provider plugins
- [Plugin Internals](/plugins/architecture) - architecture deep dive
- [Plugin Manifest](/plugins/manifest) - manifest schema reference
- [Plugin hooks](/plugins/hooks) - typed and custom hook surfaces

<a id="runtime-tasks-flow" />

For the removed Tasks and TaskFlow surfaces, see [Tasks and TaskFlow API removal](/plugins/sdk-migration/removed-surfaces#tasks-and-taskflow-apis-removed).

The `agent-runtime` snapshot publisher now provides
`replaceRuntimeAuthProfileStoreSnapshotsAsync`. Await it when publishing a default
shared-owner snapshot; it resolves cold ownership through the database worker.
The synchronous `replaceRuntimeAuthProfileStoreSnapshots` remains deprecated until
a later stable release and retains native cold-owner admission for compatibility.
Entries with explicit database paths or agent directories remain in-memory publications.
