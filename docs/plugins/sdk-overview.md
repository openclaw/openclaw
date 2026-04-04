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
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
```

Each subpath is a small, self-contained module. This keeps startup fast and
prevents circular dependency issues. For channel-specific entry/build helpers,
prefer `openclaw/plugin-sdk/channel-core`; keep `openclaw/plugin-sdk/core` for
the broader umbrella surface and shared helpers such as
`buildChannelConfigSchema`.

Do not add or depend on provider-named convenience seams such as
`openclaw/plugin-sdk/slack`, `openclaw/plugin-sdk/discord`,
`openclaw/plugin-sdk/signal`, or `openclaw/plugin-sdk/whatsapp`. Bundled plugins should compose generic SDK
subpaths inside their own `api.ts` or `runtime-api.ts` barrels, and core should
either use those plugin-local barrels or add a narrow generic SDK contract when
the need is truly cross-channel.

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
    | `plugin-sdk/channel-core` | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase` |
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
    | `plugin-sdk/provider-model-shared` | `normalizeModelCompat`, `buildProviderReplayFamilyHooks`, `sanitizeGoogleGeminiReplayHistory`, `resolveTaggedReasoningOutputMode` |
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-tools` | `buildProviderToolCompatFamilyHooks`, Gemini schema helpers |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` and similar |
    | `plugin-sdk/provider-stream` | `buildProviderStreamFamilyHooks`, stream wrapper types, provider stream wrappers, shared OpenAI/OpenRouter stream-family helpers |
    | `plugin-sdk/provider-onboard` | Onboarding config patch helpers |
    | `plugin-sdk/global-singleton` | Process-local singleton/map/cache helpers |
  </Accordion>

  <Accordion title="Auth and security subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate`, command registry helpers, sender-authorization helpers |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/secret-input` | Secret input parsing helpers |
    | `plugin-sdk/webhook-ingress` | Webhook request/target helpers |
    | `plugin-sdk/webhook-request-guards` | Request body size/timeout helpers |
  </Accordion>

  <Accordion title="Runtime and storage subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/config-runtime` | Config load/write helpers |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval helpers, approval-capability builders, auth/profile helpers, native routing/runtime helpers |
    | `plugin-sdk/infra-runtime` | System event/heartbeat helpers |
    | `plugin-sdk/collection-runtime` | Small bounded cache helpers |
    | `plugin-sdk/diagnostic-runtime` | Diagnostic flag and event helpers |
    | `plugin-sdk/error-runtime` | Error graph and formatting helpers |
    | `plugin-sdk/fetch-runtime` | Wrapped fetch, proxy, and pinned lookup helpers |
    | `plugin-sdk/host-runtime` | Hostname and SCP host normalization helpers |
    | `plugin-sdk/retry-runtime` | Retry config and retry runner helpers |
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

| Method                                           | What it registers                |
| ------------------------------------------------ | -------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)             |
| `api.registerCliBackend(...)`                    | Local CLI inference backend      |
| `api.registerChannel(...)`                       | Messaging channel                |
| `api.registerSpeechProvider(...)`                | Text-to-speech / STT synthesis   |
| `api.registerRealtimeTranscriptionProvider(...)` | Streaming realtime transcription |
| `api.registerRealtimeVoiceProvider(...)`         | Duplex realtime voice sessions   |
| `api.registerMediaUnderstandingProvider(...)`    | Image/audio/video analysis       |
| `api.registerImageGenerationProvider(...)`       | Image generation                 |
| `api.registerWebSearchProvider(...)`             | Web search                       |

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

Reserved core admin namespaces (`config.*`, `exec.approvals.*`, `wizard.*`,
`update.*`) always stay `operator.admin`, even if a plugin tries to assign a
narrower gateway method scope. Prefer plugin-specific prefixes for
plugin-owned methods.

### CLI registration metadata

`api.registerCli(registrar, opts?)` accepts two kinds of top-level metadata:

- `commands`: explicit command roots owned by the registrar
- `descriptors`: parse-time command descriptors used for root CLI help,
  routing, and lazy plugin CLI registration

If you want a plugin command to stay lazy-loaded in the normal root CLI path,
provide `descriptors` that cover every top-level command root exposed by that
registrar.

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerMatrixCli } = await import("./src/cli.js");
    registerMatrixCli({ program });
  },
  {
    descriptors: [
      {
        name: "matrix",
        description: "Manage Matrix accounts, verification, devices, and profile state",
        hasSubcommands: true,
      },
    ],
  },
);
```

Use `commands` by itself only when you do not need lazy root CLI registration.
That eager compatibility path remains supported, but it does not install
descriptor-backed placeholders for parse-time lazy loading.

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
| `api.registerMemoryFlushPlan(resolver)`    | Memory flush plan resolver            |
| `api.registerMemoryRuntime(runtime)`       | Memory runtime adapter                |

### Memory embedding adapters

| Method                                         | What it registers                              |
| ---------------------------------------------- | ---------------------------------------------- |
| `api.registerMemoryEmbeddingProvider(adapter)` | Memory embedding adapter for the active plugin |

- `registerMemoryPromptSection`, `registerMemoryFlushPlan`, and
  `registerMemoryRuntime` are exclusive to memory plugins.
- `registerMemoryEmbeddingProvider` lets the active memory plugin register one
  or more embedding adapter ids (for example `openai`, `gemini`, or a custom
  plugin-defined id).
- User config such as `agents.defaults.memorySearch.provider` and
  `agents.defaults.memorySearch.fallback` resolves against those registered
  adapter ids.

### Events and lifecycle

| Method                                       | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | Typed lifecycle hook          |
| `api.onConversationBindingResolved(handler)` | Conversation binding callback |

### Hook decision semantics

- `before_tool_call`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_tool_call`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `before_install`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_install`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `message_sending`: returning `{ cancel: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `message_sending`: returning `{ cancel: false }` is treated as no decision (same as omitting `cancel`), not as an override.

### API object fields

| Field                    | Type                      | Description                                                                |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                                  |
| `api.name`               | `string`                  | Display name                                                               |
| `api.version`            | `string?`                 | Plugin version (optional)                                                  |
| `api.description`        | `string?`                 | Plugin description (optional)                                              |
| `api.source`             | `string`                  | Plugin source path                                                         |
| `api.rootDir`            | `string?`                 | Plugin root directory (optional)                                           |
| `api.config`             | `OpenClawConfig`          | Current config snapshot (active in-memory runtime snapshot when available) |
| `api.pluginConfig`       | `Record<string, unknown>` | Plugin-specific config from `plugins.entries.<id>.config`                  |
| `api.runtime`            | `PluginRuntime`           | [Runtime helpers](/plugins/sdk-runtime)                                    |
| `api.logger`             | `PluginLogger`            | Scoped logger (`debug`, `info`, `warn`, `error`)                           |
| `api.registrationMode`   | `PluginRegistrationMode`  | `"full"`, `"setup-only"`, `"setup-runtime"`, or `"cli-metadata"`           |
| `api.resolvePath(input)` | `(string) => string`      | Resolve path relative to plugin root                                       |

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

Facade-loaded bundled plugin public surfaces (`api.ts`, `runtime-api.ts`,
`index.ts`, `setup-entry.ts`, and similar public entry files) now prefer the
active runtime config snapshot when OpenClaw is already running. If no runtime
snapshot exists yet, they fall back to the resolved config file on disk.

Provider plugins can also expose a narrow plugin-local contract barrel when a
helper is intentionally provider-specific and does not belong in a generic SDK
subpath yet. Current bundled example: the Anthropic provider keeps its Claude
stream helpers in its own public `api.ts` / `contract-api.ts` seam instead of
promoting Anthropic beta-header and `service_tier` logic into a generic
`plugin-sdk/*` contract.

Other current bundled examples:

- `@openclaw/openai-provider`: `api.ts` exports provider builders,
  default-model helpers, and realtime provider builders
- `@openclaw/openrouter-provider`: `api.ts` exports the provider builder plus
  onboarding/config helpers

<Warning>
  Extension production code should also avoid `openclaw/plugin-sdk/<other-plugin>`
  imports. If a helper is truly shared, promote it to a neutral SDK subpath
  such as `openclaw/plugin-sdk/speech`, `.../provider-model-shared`, or another
  capability-oriented surface instead of coupling two plugins together.
</Warning>

## Related

- [Entry Points](/plugins/sdk-entrypoints) — `definePluginEntry` and `defineChannelPluginEntry` options
- [Runtime Helpers](/plugins/sdk-runtime) — full `api.runtime` namespace reference
- [Setup and Config](/plugins/sdk-setup) — packaging, manifests, config schemas
- [Testing](/plugins/sdk-testing) — test utilities and lint rules
- [SDK Migration](/plugins/sdk-migration) — migrating from deprecated surfaces
- [Plugin Internals](/plugins/architecture) — deep architecture and capability model
