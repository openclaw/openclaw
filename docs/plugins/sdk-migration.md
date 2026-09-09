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

## What changed

Several wide-open import surfaces used to let plugins reach almost anything
from a single entry point:

- **`openclaw/plugin-sdk`** and **`openclaw/plugin-sdk/compat`** - re-exported
  dozens of helpers while the focused SDK was being built. Both roots are now
  removed; import a documented subpath instead.
- **`openclaw/plugin-sdk/infra-runtime`** - a broad barrel mixing system
  events, heartbeat state, delivery queues, fetch/proxy helpers, file helpers,
  approval types, and unrelated utilities.
- **`openclaw/plugin-sdk/config-runtime`** - a broad config barrel retained
  for compatibility, including deprecated direct `loadConfig` and
  `writeConfigFile` exports. Those methods were removed from the injected
  plugin runtime, not from this retained facade.
- **`openclaw/extension-api`** - a removed bridge that gave plugins direct
  access to host-side helpers like the embedded agent runner.
- **`api.registerEmbeddedExtensionFactory(...)`** - a removed embedded-runner-only
  hook that observed embedded-runner events such as `tool_result`. Use agent
  tool-result middleware instead (see [Migrate embedded tool-result extensions
  to middleware](/plugins/sdk-migration/how-to-migrate#how-to-migrate)).

The root SDK, compat barrel, extension bridge, and embedded extension factory
have been removed. `infra-runtime` and `config-runtime` remain only for their
separately recorded later windows; new plugins should use focused subpaths.

<Warning>
  Plugins importing the removed root, compat, or extension surfaces no longer
  load. Follow the [import path mappings](/plugins/sdk-migration/import-paths) before upgrading.
</Warning>

OpenClaw does not remove or reinterpret documented plugin behavior in the same
change that introduces a replacement. Breaking contract changes go through a
compatibility adapter, diagnostics, docs, and a deprecation window first. That
applies to SDK imports, manifest fields, setup APIs, hooks, and runtime
registration behavior.

`ChatCommandDefinition.category` retains the `"docks"` value accepted by the
2026.8.1 SDK. Command lists display these legacy definitions under **Tools**;
the category does not enable channel docking or restore retired docking commands.
New definitions should use `"tools"`.

### Why

- **Slow startup** - importing one helper loaded dozens of unrelated modules.
- **Circular dependencies** - broad re-exports made import cycles easy to
  create.
- **Unclear API surface** - no way to tell stable exports from internal ones.

The typed public SDK is organized into focused subpaths with documented
contracts. Not every SDK build entrypoint is a public plugin API.

Legacy provider convenience seams for bundled channels are gone too -
channel-branded helper shortcuts were private mono-repo conveniences, not
stable plugin contracts. Use narrow generic SDK subpaths instead. Inside the
bundled plugin workspace, keep provider-owned helpers in that plugin's own
`api.ts` or `runtime-api.ts`:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` seam.
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`.
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`.

## Where each topic lives

Every section of the single-page version lives on one of the six pages below.
The anchors from the single-page version still resolve here.

### Migration steps

[How to migrate a plugin](/plugins/sdk-migration/how-to-migrate) — the ordered migration steps.

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
- <a id="retained-channel-facade-mappings"></a>[Retained channel facade mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)

### Removed surfaces and replacements

[Removed surfaces and replacements](/plugins/sdk-migration/removed-surfaces) — what was removed, and the replacement for each legacy API.

- <a id="removed-compatibility-surfaces"></a>[Removed compatibility surfaces](/plugins/sdk-migration/removed-surfaces#removed-compatibility-surfaces)
- <a id="process-global-api-provider-publication"></a>[Process-global API-provider publication](/plugins/sdk-migration/removed-surfaces#process-global-api-provider-publication)
- <a id="deactivate-hook-alias"></a>[Deactivate hook alias](/plugins/sdk-migration/removed-surfaces#deactivate-hook-alias)
- <a id="private-testing-barrel"></a>[Private testing barrel](/plugins/sdk-migration/removed-surfaces#private-testing-barrel)
- <a id="migration-reference"></a>[Migration reference](/plugins/sdk-migration/removed-surfaces#migration-reference)
- <a id="command-auth"></a>[`command-auth` help builders -> `command-status`](/plugins/sdk-migration/removed-surfaces#command-auth)
- <a id="mention"></a>[Mention gating helpers -> `resolveInboundMentionDecision`](/plugins/sdk-migration/removed-surfaces#mention)
- <a id="channel-runtime-shim-and-channel-actions-helpers"></a>[Channel runtime shim and channel actions helpers](/plugins/sdk-migration/removed-surfaces#channel-runtime-shim-and-channel-actions-helpers)
- <a id="web"></a>[Web search provider `tool()` helper -> `createTool()` on the plugin](/plugins/sdk-migration/removed-surfaces#web)
- <a id="plaintext"></a>[Plaintext channel envelopes -> `BodyForAgent`](/plugins/sdk-migration/removed-surfaces#plaintext)
- <a id="subagent-spawning"></a>[`subagent_spawning` hook -> core thread binding](/plugins/sdk-migration/removed-surfaces#subagent-spawning)
- <a id="provider"></a>[Provider discovery types -> provider catalog types](/plugins/sdk-migration/removed-surfaces#provider)
- <a id="thinking"></a>[Thinking policy hooks -> `resolveThinkingProfile`](/plugins/sdk-migration/removed-surfaces#thinking)
- <a id="external"></a>[External auth providers -> `contracts.externalAuthProviders`](/plugins/sdk-migration/removed-surfaces#external)
- <a id="provider-1"></a>[Provider env-var lookup -> `setup.providers[].envVars`](/plugins/sdk-migration/removed-surfaces#provider-1)
- <a id="memory"></a>[Memory plugin registration -> `registerMemoryCapability`](/plugins/sdk-migration/removed-surfaces#memory)
- <a id="memory-embedding-provider-api"></a>[Memory embedding provider API](/plugins/sdk-migration/removed-surfaces#memory-embedding-provider-api)
- <a id="raw"></a>[Raw channel send results -> `OutboundDeliveryResult`](/plugins/sdk-migration/removed-surfaces#raw)
- <a id="subagent-session-messages-types-renamed"></a>[Subagent session messages types renamed](/plugins/sdk-migration/removed-surfaces#subagent-session-messages-types-renamed)
- <a id="removed-session-and-transcript-file-apis"></a>[Removed session and transcript file APIs](/plugins/sdk-migration/removed-surfaces#removed-session-and-transcript-file-apis)
- <a id="agent"></a>[Agent harness attempt params -> V2 host-capability contract](/plugins/sdk-migration/removed-surfaces#agent)
- <a id="runtime-tasks-flow"></a>[`runtime.tasks.flow` -> `runtime.tasks.managedFlows`](/plugins/sdk-migration/removed-surfaces#runtime-tasks-flow)
- <a id="embedded"></a>[Embedded extension factories -> agent tool-result middleware](/plugins/sdk-migration/removed-surfaces#embedded)
- <a id="openclawschematype"></a>[`OpenClawSchemaType` alias -> `OpenClawConfig`](/plugins/sdk-migration/removed-surfaces#openclawschematype)

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
