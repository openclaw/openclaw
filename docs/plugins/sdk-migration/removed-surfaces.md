---
doc-schema-version: 1
summary: "Removed SDK surfaces and the replacement for each removed or deprecated API"
read_when:
  - A removed export, hook, or manifest field is breaking your plugin
  - You need the replacement for a specific legacy API
title: "Removed surfaces and replacements"
sidebarTitle: "Removed surfaces"
---

What the July 2026 sweep removed, plus the per-API replacement mappings for removed surfaces and later-window deprecations. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Removed compatibility surfaces

The July 2026 sweep removed the root SDK and compat barrels, the extension API
bridge, the expired SDK subpath aliases, unused SDK subpaths, and typed-public
access to bundled-only SDK modules. Private-local build mappings remain for
repository owners, and production-private JavaScript exports support official
plugin runtimes. Neither provides typed third-party SDK access.

### Channel, config, and infrastructure compatibility facades

`channel-lifecycle`, `channel-message`, `channel-reply-pipeline`,
`config-runtime`, and `infra-runtime` were removed with SDK-owner approval on
September 30, 2026. Channel imports move to focused outbound and inbound
contracts; config access uses supplied config, snapshots, and mutation helpers;
infrastructure imports move to the matching focused runtime or injected API.
System-event snapshot inspection and consumption use `system-event-runtime`.

Some legacy helpers and named types require caller changes rather than an
import-path substitution. See the [channel mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)
and [config and infrastructure migration steps](/plugins/sdk-migration/how-to-migrate).

### Command, Discord, and Telegram account facades

`command-auth`, `discord`, and `telegram-account` were removed with explicit
SDK-owner approval on October 2, 2026. Move sender authorization to
`channel-ingress-runtime`, native command helpers to `command-auth-native`, and
help builders to `command-status`. Discord and Telegram behavior remains owned
by their plugins; use generic channel contracts and injected runtime helpers
from external plugins, and the owning plugin's `api.ts` / `runtime-api.ts`
barrels for repository consumers.

These are breaking removals for third-party plugins that still import the old
subpaths, including older published `@openclaw/discord` packages. Upgrade affected
plugins before upgrading the host. Not every export has a path-only replacement;
see the [per-surface mappings](/plugins/sdk-migration/import-paths#removed-command-and-channel-facades).

### Retroactively recorded shipped exports

The following exports shipped in `v2026.9.8` and were removed without a
compatibility window. Their removals were recorded retroactively on October 7,
2026 when the shipped-surface guard was introduced; the exports remain removed.
The registry's `removeAfter` is the UTC day before the removing commit landed,
not a compatibility window that was offered to plugin authors.

| Removed export (`openclaw/plugin-sdk/` prefix)                 | Landed (UTC) | `removeAfter` | Replacement                                                                                           |
| -------------------------------------------------------------- | ------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| `allow-from.mapBasicAllowlistResolutionEntries`                | 2026-10-05   | 2026-10-04    | None; project `BasicAllowlistResolutionEntry` fields in the consuming plugin.                         |
| `computer-use.compileComputerUseValidator`                     | 2026-10-05   | 2026-10-04    | `Compile(schema).Check` from `typebox/compile`, using the exported Computer Use schemas.              |
| `extension-shared.runStoppablePassiveMonitor`                  | 2026-10-05   | 2026-10-04    | `channel-outbound.runPassiveAccountLifecycle` with `stop: (monitor) => monitor.stop()`.               |
| `gateway-runtime.resolveAdvertisedLanHost`                     | 2026-10-05   | 2026-10-04    | None; advertised LAN host discovery is host-owned.                                                    |
| `json-store.readJsonFileWithFallback`                          | 2026-10-05   | 2026-10-04    | None; own JSON artifact parsing, fallback, and file-existence handling in the plugin.                 |
| `provider-auth.normalizeSecretInputModeInput`                  | 2026-10-05   | 2026-10-04    | None; validate plugin-owned input as the exported `SecretInputMode` values `plaintext` or `ref`.      |
| `persistent-dedupe.PersistentDedupeLegacyJsonMigrationOptions` | 2026-10-05   | 2026-10-04    | None; the legacy JSON migration was retired.                                                          |
| `persistent-dedupe.PersistentDedupeLegacyJsonMigrationResult`  | 2026-10-05   | 2026-10-04    | None; the legacy JSON migration was retired.                                                          |
| `persistent-dedupe.listPersistentDedupeLegacyJsonFileEntries`  | 2026-10-05   | 2026-10-04    | None; the legacy JSON migration was retired.                                                          |
| `persistent-dedupe.migratePersistentDedupeLegacyJsonFile`      | 2026-10-05   | 2026-10-04    | None; the legacy JSON migration was retired. Runtime dedupe continues through the SQLite-backed APIs. |
| `provider-auth.CachedCopilotToken`                             | 2026-10-02   | 2026-10-01    | Provider-local GitHub Copilot auth APIs; none in the public SDK.                                      |
| `provider-auth.DEFAULT_COPILOT_API_BASE_URL`                   | 2026-10-02   | 2026-10-01    | Provider-local GitHub Copilot auth APIs; none in the public SDK.                                      |
| `provider-auth.deriveCopilotApiBaseUrlFromToken`               | 2026-10-02   | 2026-10-01    | Provider-local GitHub Copilot auth APIs; none in the public SDK.                                      |
| `provider-auth.resolveCopilotApiToken`                         | 2026-10-02   | 2026-10-01    | Provider-local GitHub Copilot auth APIs; none in the public SDK.                                      |

The first six exports were removed in
[`2fec39f57319be5b6e0b20b5305665ed1ff5e685`](https://github.com/openclaw/openclaw/commit/2fec39f57319be5b6e0b20b5305665ed1ff5e685).
The four legacy JSON migration exports were removed in
[`bd64d93ff1ae704d13813f6580c4809ba0e76606`](https://github.com/openclaw/openclaw/commit/bd64d93ff1ae704d13813f6580c4809ba0e76606).
The four Copilot exports and their earlier deprecation entries were removed in
[`f2de06b38de710854aacd19218327358445816c8`](https://github.com/openclaw/openclaw/commit/f2de06b38de710854aacd19218327358445816c8);
third-party plugins must own their provider-specific token exchange and caching.

### Tool argument redaction

`sanitizeToolArgs` was removed from `openclaw/plugin-sdk/agent-harness-runtime`
on October 11, 2026, as part of the maintainer-approved removal of automatic
tool argument and result masking. Remove its import and pass arguments unchanged.
There is no replacement or compatibility masking path. Logging and diagnostic
redaction helpers remain available.

### Process-global API-provider publication

`registerApiProvider(...)` and `unregisterApiProviders(...)` were removed from
`openclaw/plugin-sdk/llm`. They published API transports into process-global
state, which lifecycle-owned model runtimes then had to copy into each prepared
registry.

Provider plugins should register text-inference providers through
`api.registerProvider(...)`. Host-owned code and tests that construct an
`ApiRegistry` should register directly on that registry so provider ownership
and teardown stay scoped to the prepared runtime.

### Deactivate hook alias

The `api.on("deactivate", handler)` compatibility alias was removed. Register
the same shutdown cleanup with `gateway_stop`:

```typescript
// Before
api.on("deactivate", async (event, ctx) => {
  await stopPluginService(ctx);
});

// After
api.on("gateway_stop", async (event, ctx) => {
  await stopPluginService(ctx);
});
```

### Skill Workshop proposal hooks

The `skill_proposal_evaluate` and `skill_proposal_changed` hooks were removed
together with Skill Workshop proposals. Workshop now applies each change
immediately and keeps a restorable version, so there is no pending draft to
evaluate and no proposal lifecycle to observe. The hook runner methods
`runSkillProposalEvaluate` and `runSkillProposalChanged` were removed, and
`openclaw/plugin-sdk/plugin-entry` no longer exports
`PluginHookSkillProposalEvaluateEvent`, `PluginHookSkillProposalEvaluateResult`,
`PluginHookSkillProposalEvaluationOutcome`, `PluginHookSkillProposalChangedEvent`,
`PluginHookSkillProposalKind`, `PluginHookSkillEvaluationFinding`,
`PluginHookSkillBundleFile`, or `PluginHookSkillBundleSnapshot`. The optional
`proposal` field on `PluginHookSkillChangedEvent` was removed too.

To observe committed Workshop skill writes, register `skill_changed` and filter
on `source: "workshop"`. There is no replacement for pre-apply evaluation.
Registering a removed hook name logs an `unknown typed hook` warning and the
handler never runs.

### Private testing barrel

`openclaw/plugin-sdk/testing` was repo-local and excluded from shipped package
artifacts, so it was removed before its 2026-07-28 `removeAfter` date. Repository
tests use focused subpaths such as `plugin-sdk/plugin-test-runtime`,
`plugin-sdk/channel-test-helpers`, `plugin-sdk/channel-target-testing`,
`plugin-sdk/test-env`, and `plugin-sdk/test-fixtures`.

### Credential prompt builder

`buildCredentialSafetyPrompt` remains available from
`openclaw/plugin-sdk/agent-harness-runtime`. With an options object whose
`controlToolsAvailable` is set from the callable `openclaw` and `gateway` tools, it
returns guidance to use or store user-shared credentials as asked, complete the
task, and briefly acknowledge their use or storage in the final reply without
repeating their values. The acknowledgment stays factual and non-alarming. It also
returns the private login-code handoff guidance and the terminal setup route when
neither control tool is available.

The legacy string argument is deprecated from 2026-09-09 and remains supported
through 2026-11-30. It is accepted and ignored: availability is unknown, so the
helper returns only the private handoff line. Replace strings with
`{ controlToolsAvailable }`; the string form is eligible for removal starting
2026-12-01. The helper itself is not deprecated.

## Migration reference

These mappings cover both removed July 2026 surfaces and later-window active
deprecations. A mapping is migration guidance, not evidence that the old
surface remains available; consult the compatibility registry and removal
timeline for current status.

<AccordionGroup>
  <Accordion title="command-auth help builders -> command-status">
    **Old (`openclaw/plugin-sdk/command-auth`)**: `buildCommandsMessage`,
    `buildCommandsMessagePaginated`, `buildHelpMessage`.

    **New (`openclaw/plugin-sdk/command-status`)**: same signatures, imported
    from the narrower subpath. The `command-auth` compatibility re-exports
    have been removed.

    ```typescript
    // Before
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-auth";

    // After
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-status";
    ```

  </Accordion>

  <Accordion title="Mention gating helpers -> resolveInboundMentionDecision">
    **Old**: `resolveMentionGating(params)` and
    `resolveMentionGatingWithBypass(params)` from
    `openclaw/plugin-sdk/channel-inbound` or
    `openclaw/plugin-sdk/channel-mention-gating`.

    **New**: `resolveInboundMentionDecision({ facts, policy })` - one decision
    object instead of two split call shapes.

    Adopted across Discord, iMessage, Matrix, MS Teams, QQBot, Signal,
    Telegram, WhatsApp, and Zalo. Slack's own `app_mention` event model does
    not use this helper.

  </Accordion>

  <Accordion title="Channel runtime shim and channel actions helpers">
    `openclaw/plugin-sdk/channel-runtime` has been removed. Use
    `openclaw/plugin-sdk/channel-runtime-context` for registering runtime
    objects.

    The native message schema helpers in `openclaw/plugin-sdk/channel-actions`
    were removed alongside raw "actions" channel exports. Expose capabilities
    through the semantic `presentation` surface instead - channel plugins
    declare what they render (cards, buttons, selects) rather than which raw
    action names they accept.

  </Accordion>

  <Accordion title="Web search provider tool() helper -> createTool() on the plugin">
    **Old**: `tool()` factory from `openclaw/plugin-sdk/provider-web-search`.

    **New**: implement `createTool(...)` directly on the provider plugin.
    OpenClaw no longer needs the SDK helper to register the tool wrapper.

  </Accordion>

  <Accordion title="Plaintext channel envelopes -> BodyForAgent">
    **Old**: `api.runtime.channel.reply.formatInboundEnvelope(...)` (and the
    `channelEnvelope` field on inbound message objects) to build a flat
    plaintext prompt envelope from inbound channel messages.

    **New**: `BodyForAgent` plus structured user-context blocks. Channel
    plugins attach routing metadata (thread, topic, reply-to, reactions) as
    typed fields instead of concatenating them into a prompt string. The
    `formatAgentEnvelope(...)` helper is still supported for synthesized
    assistant-facing envelopes, but inbound plaintext envelopes are on the way
    out.

    Affected areas: `inbound_claim`, `message_received`, and any custom
    channel plugin that post-processed the old envelope text.

  </Accordion>

  <Accordion title="subagent_spawning hook -> core thread binding">
    **Old**: `api.on("subagent_spawning", handler)` returning
    `threadBindingReady` or `deliveryOrigin`.

    **New**: let core prepare `thread: true` subagent bindings through the
    channel session-binding adapter. Use `api.on("subagent_spawned", handler)`
    only for post-launch observation.

    ```typescript
    // Before
    api.on("subagent_spawning", async () => ({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: { channel: "discord", to: "channel:123", threadId: "456" },
    }));

    // After
    api.on("subagent_spawned", async (event) => {
      await observeSubagentLaunch(event);
    });
    ```

    The `subagent_spawning` hook and its event/result types were removed in
    August 2026 after thread binding moved to the core session-binding path.

  </Accordion>

  <Accordion title="Provider discovery types -> provider catalog types">
    Four discovery type aliases are now thin wrappers over the catalog-era
    types:

    | Old alias                 | New type                  |
    | ------------------------- | ------------------------- |
    | `ProviderDiscoveryOrder`  | `ProviderCatalogOrder`    |
    | `ProviderDiscoveryContext`| `ProviderCatalogContext`  |
    | `ProviderDiscoveryResult` | `ProviderCatalogResult`   |
    | `ProviderPluginDiscovery` | `ProviderPluginCatalog`   |

    The aliases and legacy `ProviderCapabilities` static bag have been
    removed. Provider plugins
    should use explicit provider hooks such as `buildReplayPolicy`,
    `normalizeToolSchemas`, and `wrapStreamFn` rather than a static object.

  </Accordion>

  <Accordion title="Thinking policy hooks -> resolveThinkingProfile">
    **Old** (three separate hooks on `ProviderThinkingPolicy`):
    `isBinaryThinking(ctx)`, `supportsXHighThinking(ctx)`, and
    `resolveDefaultThinkingLevel(ctx)`.

    **New**: a single `resolveThinkingProfile(ctx)` that returns a
    `ProviderThinkingProfile` with the canonical `id`, optional `label`, and a
    ranked level list. OpenClaw downgrades stale stored values by profile rank
    automatically.

    The context includes `provider`, `modelId`, optional merged `reasoning`,
    and optional merged model `compat` facts. Provider plugins can use those
    catalog facts to expose a model-specific profile only when the configured
    request contract supports it.

    Implement one hook instead of three. The legacy hooks have been removed.

  </Accordion>

  <Accordion title="External auth providers -> contracts.externalAuthProviders">
    **Old**: implementing external auth hooks without declaring the provider
    in the plugin manifest.

    **New**: declare `contracts.externalAuthProviders` in the plugin manifest
    **and** implement `resolveExternalAuthProfiles(...)`.

    ```json
    {
      "contracts": {
        "externalAuthProviders": ["anthropic", "openai"]
      }
    }
    ```

  </Accordion>

  <Accordion title="Provider env-var lookup -> setup.providers[].envVars">
    **Old** manifest field: `providerAuthEnvVars: { anthropic: ["ANTHROPIC_API_KEY"] }`.

    **New**: mirror the same env-var lookup into `setup.providers[].envVars`
    on the manifest. This consolidates setup/status env metadata in one place
    and avoids booting the plugin runtime just to answer env-var lookups.

    `providerAuthEnvVars` is no longer accepted.

  </Accordion>

  <Accordion title="Memory plugin registration -> registerMemoryCapability">
    **Old**: three separate calls - `api.registerMemoryPromptSection(...)`,
    `api.registerMemoryFlushPlan(...)`, `api.registerMemoryRuntime(...)`.

    **New**: one call on the memory-state API -
    `registerMemoryCapability(pluginId, { promptBuilder, flushPlanResolver, runtime })`.

    Same slots, single registration call. Additive prompt and corpus helpers
    (`registerMemoryPromptSupplement`, `registerMemoryCorpusSupplement`) are
    not affected.

  </Accordion>

  <Accordion title="Memory embedding provider API">
    **Old**: `api.registerMemoryEmbeddingProvider(...)` plus
    `contracts.memoryEmbeddingProviders`.

    **New**: `api.registerEmbeddingProvider(...)` plus
    `contracts.embeddingProviders`.

    The generic embedding provider contract is reusable outside memory and is
    the supported path for every provider. The memory-specific registration API
    and manifest contract were removed after the **2026-08-21** migration
    deadline.

  </Accordion>

  <Accordion title="Raw channel send results -> OutboundDeliveryResult">
    **Old**: return `{ ok, messageId, error }` through
    `ChannelSendRawResult` and normalize it with
    `createRawChannelSendResultAdapter(...)`.

    **New**: return `OutboundDeliveryResult` fields and attach the channel with
    `createAttachedChannelResultAdapter(...)`. Failed sends should throw instead
    of returning an error string. Put the platform destination in
    `target: { kind: "chat" | "channel" | "room" | "conversation", id }`;
    the old parallel `chatId`, `channelId`, `roomId`, and `conversationId`
    result fields are no longer accepted. The raw result type remains available
    until the next plugin-SDK major release.

  </Accordion>

  <Accordion title="Subagent session messages types renamed">
    Two legacy type aliases still exported from `src/plugins/runtime/types.ts`:

    | Old                           | New                             |
    | ----------------------------- | ------------------------------- |
    | `SubagentReadSessionParams`   | `SubagentGetSessionMessagesParams` |
    | `SubagentReadSessionResult`   | `SubagentGetSessionMessagesResult` |

    The runtime method `readSession` is deprecated in favor of
    `getSessionMessages`. Same signature; the old method calls through to the
    new one.

  </Accordion>

  <Accordion title="Removed session and transcript file APIs">
    The SQLite session/transcript flip removes or deprecates plugin-facing APIs
    that exposed active `sessions.json` stores, JSONL transcript paths, or lists
    of session files. Runtime plugins should use session identity and SDK runtime
    helpers instead of resolving or mutating active files.

    | Migrating surface | Replacement |
    | ----------------- | ----------- |
    | Removed `loadSessionStore(...)` and `resolveSessionStoreEntry(...)`, including package-root `loadSessionStore(...)` | `getSessionEntry(...)` for one scoped row or `listSessionEntries(...)` for scoped iteration from `openclaw/plugin-sdk/session-store-runtime`. |
    | Removed `updateSessionStore(...)`, package-root `saveSessionStore(...)`, and SDK file-store writes | `patchSessionEntry(...)`, `upsertSessionEntry(...)`, and `deleteSessionEntry(...)` from `openclaw/plugin-sdk/session-store-runtime`; mutate only the intended rows instead of replacing a detached whole-store snapshot. |
    | Removed `LoadSessionStoreOptions` and `UpdateSessionStoreOptions` | Parameters accepted by the scoped row APIs; the whole-store cache and callback options no longer apply. |
    | Removed `resolveSessionFilePath(...)` | Session identity (`agentId`, `sessionKey`, and `sessionId`) with `openclaw/plugin-sdk/session-transcript-runtime`, or Gateway methods that operate on the current session. |
    | Removed `resolveSessionTranscriptPathInDir(...)` and `resolveAndPersistSessionFile(...)` | Session identity and Gateway methods that operate on the current session. |
    | `readLatestAssistantTextFromSessionTranscript(...)` | Identity-backed transcript readers exposed by the current runtime context, or Gateway history/session methods when the plugin is outside the transcript owner path. |
    | `SessionTranscriptUpdate.sessionFile` | `SessionTranscriptUpdate.target` with `agentId`, `sessionKey`, and `sessionId`. |
    | Memory sync inputs such as `sessionFiles` | Identity-backed transcript/session sources provided by the host; do not crawl active JSONL files for live sessions. |
    | Runtime options named `transcriptPath` or `sessionFile` for active sessions | `sessionTarget`/runtime target objects that carry storage-neutral session identity. |

    Legacy JSONL transcript files remain valid as import, archive, export, and
    support artifacts. They are no longer the steady-state runtime contract for
    active sessions.

    The official `@openclaw/codex` and `@openclaw/feishu` plugins released with
    `v2026.7.1-beta.5` imported the retired bridge. SDK-owner approval on
    September 30, 2026 closed its compatibility window early, replacing the
    former October 12 deadline. The supported-plugin cutoff excludes that
    release and any other package still importing the
    bridge. Upgrade affected plugins to versions using the replacements before
    upgrading OpenClaw. A newer version number alone is not evidence of migration.

    `openclaw/plugin-sdk/session-store-runtime` and `resolveStorePath(...)`
    remain supported. Pass the selected `agentId` explicitly to scoped row
    operations; resolving a path no longer records an agent selection for a
    later whole-store call. This removal does not change SQLite schemas or
    legacy-state import and Doctor migrations.

    `openclaw plugins inspect --all --runtime` reports non-bundled plugins whose
    load errors or diagnostics still reference these removed file APIs. The
    `@openclaw/plugin-inspector` advisory sweep must use version `0.3.17` or
    newer so external package scans also flag whole-store session helpers,
    session file-path helpers, legacy transcript file targets, and low-level
    transcript helpers before release.

  </Accordion>

  <Accordion title="Agent harness attempt params -> V2 host-capability contract">
    New or updated harness plugins should implement `AgentHarnessV2` and use
    `AgentHarnessAttemptParamsV2`, `EmbeddedRunAttemptParamsV2`, or
    `AgentHarnessSideQuestionParamsV2`. The V2 parameter types require
    `hostCapabilities`, matching what core supplies at the selected-harness
    boundary. A plugin that adopts these V2 contracts must declare
    `openclaw.compat.pluginApi: ">=2026.8.1"` (or a newer floor) in its package
    manifest so an older host rejects the plugin before loading it.

    Existing plugins may continue implementing `AgentHarness` and constructing
    the legacy `AgentHarnessAttemptParams`, `EmbeddedRunAttemptParams`, or
    `AgentHarnessSideQuestionParams` types without that field through
    2026-10-12. Those contracts keep the capability optional only for source
    compatibility; they do not create a capability-free runtime path. Migrate
    by changing the imported type name and binding tool or native-action surfaces through
    `params.hostCapabilities`.

  </Accordion>

  <Accordion title="Tasks and TaskFlow APIs removed">
    The Tasks registry and TaskFlow orchestration APIs have been removed,
    including `api.runtime.tasks`, `registerDetachedTaskRuntime`, and the
    `agent-harness-task-runtime` SDK subpath. No compatibility facade remains.
    Use native subagent launch/wait/history APIs, cron run history, and the
    ordinary Lobster runner for their respective operations. Harness completion
    routing uses the completion-only `agent-harness-completion` subpath.
    This removal does not change the physical database schemas. Existing
    `task_runs`, `task_delivery_state`, and `flow_runs` tables, columns, and indexes
    remain unchanged. Cron reads and writes only its `runtime = 'cron'` history
    rows in `task_runs`; non-Cron Task and TaskFlow rows remain untouched and
    unused by the runtime. The Codex plugin's
    [Doctor migration](/gateway/doctor/config-migrations#native-codex-recovery-after-tasks-removal)
    preserves eligible owner-stamped native recovery facts in existing parent
    binding metadata, leaving source rows byte-identical. It adds no runtime Task
    reader or replacement SDK surface; current requester authority still governs
    completion delivery. See the [versioning contract](/reference/database-schemas/versioning).
  </Accordion>

  <Accordion title="Embedded extension factories -> agent tool-result middleware">
    Covered in [How to migrate](/plugins/sdk-migration/how-to-migrate#how-to-migrate). Included here for
    completeness: the removed embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` path is replaced by
    `api.registerAgentToolResultMiddleware(...)` with an explicit runtime list
    in `contracts.agentToolResultMiddleware`.
  </Accordion>

  <Accordion title="OpenClawSchemaType alias -> OpenClawConfig">
    The `OpenClawSchemaType` root-SDK alias was removed. Use the canonical
    `OpenClawConfig` name.

    ```typescript
    // Before
    import type { OpenClawSchemaType } from "openclaw/plugin-sdk";
    // After
    import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
    ```

  </Accordion>
</AccordionGroup>

<Note>
Extension-level deprecations (inside bundled channel/provider plugins under
`extensions/`) are tracked inside their own `api.ts` and `runtime-api.ts`
barrels. They do not affect third-party plugin contracts and are not listed
here. If you consume a bundled plugin's local barrel directly, read the
deprecation comments in that barrel before upgrading.
</Note>
