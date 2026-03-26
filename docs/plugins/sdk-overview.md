---
title: "Plugin SDK Overview"
sidebarTitle: "SDK Overview"
summary: "Import map, registration API reference, and SDK architecture"
read_when:
  - You need to know which SDK subpath to import from
  - You want a reference for all registration methods on OpenClawPluginApi
  - You are looking up a specific SDK export
---

# Plugin SDK Overview

The plugin SDK is the typed contract between plugins and core. This page is the
reference for **what to import** and **what you can register**.

<Tip>
  **Looking for a how-to guide?**
  - First plugin? Start with [Getting Started](/plugins/building-plugins)
  - Channel plugin? See [Channel Plugins](/plugins/sdk-channel-plugins)
  - Provider plugin? See [Provider Plugins](/plugins/sdk-provider-plugins)
</Tip>

## Import convention

Always import from a specific subpath:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
```

Each subpath is a small, self-contained module. This keeps startup fast and
prevents circular dependency issues.

## Subpath reference

The most commonly used subpaths, grouped by purpose. The full list of 100+
subpaths is in `scripts/lib/plugin-sdk-entrypoints.json`.

### Plugin entry

| Subpath                   | Key exports                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry` | `definePluginEntry`                                                                                                                    |
| `plugin-sdk/core`         | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema` |

<AccordionGroup>
  <Accordion title="Channel subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface` |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline` |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter` |
    | `plugin-sdk/channel-config-schema` | Channel config schema types |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-lifecycle` | `createAccountStatusSink` |
    | `plugin-sdk/channel-inbound` | Debounce, mention matching, envelope helpers |
    | `plugin-sdk/channel-send-result` | Reply result types |
    | `plugin-sdk/channel-actions` | `createMessageToolButtonsSchema`, `createMessageToolCardSchema` |
    | `plugin-sdk/channel-targets` | Target parsing/matching helpers |
    | `plugin-sdk/channel-contract` | Channel contract types |
    | `plugin-sdk/channel-feedback` | Feedback/reaction wiring |
  </Accordion>

  <Accordion title="Provider subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/cli-backend` | CLI backend defaults + watchdog constants |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`, `ensureApiKeyFromOptionEnvOrPrompt`, `upsertAuthProfile` |
    | `plugin-sdk/provider-models` | `normalizeModelCompat` |
    | `plugin-sdk/provider-catalog` | Catalog type re-exports |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` and similar |
    | `plugin-sdk/provider-stream` | Stream wrapper types |
    | `plugin-sdk/provider-onboard` | Onboarding config patch helpers |
  </Accordion>

  <Accordion title="Auth and security subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate` |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/secret-input` | Secret input parsing helpers |
    | `plugin-sdk/webhook-ingress` | Webhook request/target helpers |
  </Accordion>

  <Accordion title="Runtime and storage subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/config-runtime` | Config load/write helpers |
    | `plugin-sdk/infra-runtime` | System event/heartbeat helpers |
    | `plugin-sdk/agent-runtime` | Agent dir/identity/workspace helpers |
    | `plugin-sdk/directory-runtime` | Config-backed directory query/dedup |
    | `plugin-sdk/keyed-async-queue` | `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="Capability and testing subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/image-generation` | Image generation provider types |
    | `plugin-sdk/media-understanding` | Media understanding provider types |
    | `plugin-sdk/speech` | Speech provider types |
    | `plugin-sdk/testing` | `installCommonResolveTargetErrorCases`, `shouldAckReaction` |
  </Accordion>
</AccordionGroup>

## Registration API

The `register(api)` callback receives an `OpenClawPluginApi` object with these
methods:

### Capability registration

| Method                                        | What it registers              |
| --------------------------------------------- | ------------------------------ |
| `api.registerProvider(...)`                   | Text inference (LLM)           |
| `api.registerCliBackend(...)`                 | Local CLI inference backend    |
| `api.registerChannel(...)`                    | Messaging channel              |
| `api.registerSpeechProvider(...)`             | Text-to-speech / STT synthesis |
| `api.registerMediaUnderstandingProvider(...)` | Image/audio/video analysis     |
| `api.registerImageGenerationProvider(...)`    | Image generation               |
| `api.registerWebSearchProvider(...)`          | Web search                     |

### Tools and commands

| Method                          | What it registers                             |
| ------------------------------- | --------------------------------------------- |
| `api.registerTool(tool, opts?)` | Agent tool (required or `{ optional: true }`) |
| `api.registerCommand(def)`      | Custom command (bypasses the LLM)             |

### Infrastructure

| Method                                         | What it registers     |
| ---------------------------------------------- | --------------------- |
| `api.registerHook(events, handler, opts?)`     | Event hook            |
| `api.registerHttpRoute(params)`                | Gateway HTTP endpoint |
| `api.registerGatewayMethod(name, handler)`     | Gateway RPC method    |
| `api.registerCli(registrar, opts?)`            | CLI subcommand        |
| `api.registerService(service)`                 | Background service    |
| `api.registerInteractiveHandler(registration)` | Interactive handler   |

### CLI backend registration

`api.registerCliBackend(...)` lets a plugin own the default config for a local
AI CLI backend such as `claude-cli` or `codex-cli`.

- The backend `id` becomes the provider prefix in model refs like `claude-cli/opus`.
- The backend `config` uses the same shape as `agents.defaults.cliBackends.<id>`.
- User config still wins. OpenClaw merges `agents.defaults.cliBackends.<id>` over the
  plugin default before running the CLI.
- Use `normalizeConfig` when a backend needs compatibility rewrites after merge
  (for example normalizing old flag shapes).

### Exclusive slots

| Method                                     | What it registers                     |
| ------------------------------------------ | ------------------------------------- |
| `api.registerContextEngine(id, factory)`   | Context engine (one active at a time) |
| `api.registerMemoryPromptSection(builder)` | Memory prompt section builder         |

### Events and lifecycle

| Method                                       | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | Typed lifecycle hook          |
| `api.onConversationBindingResolved(handler)` | Conversation binding callback |

### Hook decision semantics

- `before_tool_call`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_tool_call`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `message_sending`: returning `{ cancel: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `message_sending`: returning `{ cancel: false }` is treated as no decision (same as omitting `cancel`), not as an override.

### API object fields

| Field                    | Type                      | Description                                               |
| ------------------------ | ------------------------- | --------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                 |
| `api.name`               | `string`                  | Display name                                              |
| `api.version`            | `string?`                 | Plugin version (optional)                                 |
| `api.description`        | `string?`                 | Plugin description (optional)                             |
| `api.source`             | `string`                  | Plugin source path                                        |
| `api.rootDir`            | `string?`                 | Plugin root directory (optional)                          |
| `api.config`             | `OpenClawConfig`          | Current config snapshot                                   |
| `api.pluginConfig`       | `Record<string, unknown>` | Plugin-specific config from `plugins.entries.<id>.config` |
| `api.runtime`            | `PluginRuntime`           | [Runtime helpers](/plugins/sdk-runtime)                   |
| `api.logger`             | `PluginLogger`            | Scoped logger (`debug`, `info`, `warn`, `error`)          |
| `api.registrationMode`   | `PluginRegistrationMode`  | `"full"`, `"setup-only"`, or `"setup-runtime"`            |
| `api.resolvePath(input)` | `(string) => string`      | Resolve path relative to plugin root                      |

## Internal module convention

Within your plugin, use local barrel files for internal imports:

```
my-plugin/
  api.ts            # Public exports for external consumers
  runtime-api.ts    # Internal-only runtime exports
  index.ts          # Plugin entry point
  setup-entry.ts    # Lightweight setup-only entry (optional)
```

<Warning>
  Never import your own plugin through `openclaw/plugin-sdk/<your-plugin>`
  from production code. Route internal imports through `./api.ts` or
  `./runtime-api.ts`. The SDK path is the external contract only.
</Warning>

## Related

- [Entry Points](/plugins/sdk-entrypoints) — `definePluginEntry` and `defineChannelPluginEntry` options
- [Runtime Helpers](/plugins/sdk-runtime) — full `api.runtime` namespace reference
- [Setup and Config](/plugins/sdk-setup) — packaging, manifests, config schemas
- [Testing](/plugins/sdk-testing) — test utilities and lint rules
- [SDK Migration](/plugins/sdk-migration) — migrating from deprecated surfaces
- [Plugin Internals](/plugins/architecture) — deep architecture and capability model
