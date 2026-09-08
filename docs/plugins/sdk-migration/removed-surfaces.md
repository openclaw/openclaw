---
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

### Private testing barrel

`openclaw/plugin-sdk/testing` was repo-local and excluded from shipped package
artifacts, so it was removed before its 2026-07-28 `removeAfter` date. Repository
tests use focused subpaths such as `plugin-sdk/plugin-test-runtime`,
`plugin-sdk/channel-test-helpers`, `plugin-sdk/channel-target-testing`,
`plugin-sdk/test-env`, and `plugin-sdk/test-fixtures`.

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
    | Deprecated `loadSessionStore(...)`, `updateSessionStore(...)`, and `resolveSessionStoreEntry(...)`, including package-root `loadSessionStore(...)` | `getSessionEntry(...)`, `listSessionEntries(...)`, and row-level session mutations. |
    | Deprecated `resolveSessionFilePath(...)` | Session identity (`sessionKey`, `sessionId`, and SDK runtime target helpers) plus Gateway methods that operate on the current session. |
    | Deprecated package-root `saveSessionStore(...)` and removed SDK file-store writes | Gateway-owned session runtime APIs; plugin code should request or mutate session state through documented runtime/context helpers instead of writing the active store file. |
    | Removed `resolveSessionTranscriptPathInDir(...)` and `resolveAndPersistSessionFile(...)` | Session identity and Gateway methods that operate on the current session. |
    | `readLatestAssistantTextFromSessionTranscript(...)` | Identity-backed transcript readers exposed by the current runtime context, or Gateway history/session methods when the plugin is outside the transcript owner path. |
    | `SessionTranscriptUpdate.sessionFile` | `SessionTranscriptUpdate.target` with `agentId`, `sessionKey`, and `sessionId`. |
    | Memory sync inputs such as `sessionFiles` | Identity-backed transcript/session sources provided by the host; do not crawl active JSONL files for live sessions. |
    | Runtime options named `transcriptPath` or `sessionFile` for active sessions | `sessionTarget`/runtime target objects that carry storage-neutral session identity. |

    Legacy JSONL transcript files remain valid as import, archive, export, and
    support artifacts. They are no longer the steady-state runtime contract for
    active sessions.

    Official plugins released with `v2026.7.1-beta.5` imported the four
    deprecated helpers above. `openclaw/plugin-sdk/session-store-runtime` keeps
    that exact bridge through 2026-10-12; new plugins must use the replacements.
    `resolveStorePath(...)` remains a supported SDK helper and is not part of
    this deprecation.

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

  <Accordion title="runtime.tasks.flow -> runtime.tasks.managedFlows">
    **Old**: `runtime.tasks.flow` (singular) returned a live task-flow
    accessor.

    **New**: `runtime.tasks.managedFlows` keeps the managed TaskFlow mutation
    runtime for plugins that create, update, cancel, or run child tasks from a
    flow. Use `runtime.tasks.flows` when the plugin only needs DTO-based
    reads.

    ```typescript
    // Before
    const flow = api.runtime.tasks.flow.fromToolContext(ctx);
    // After
    const flow = api.runtime.tasks.managedFlows.fromToolContext(ctx);
    ```

    The legacy aliases were removed in July 2026.

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
