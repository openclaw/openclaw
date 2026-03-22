---
title: "Plugin SDK Overview"
sidebarTitle: "SDK Overview"
summary: "Registration API reference, import guidance, and SDK architecture"
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
  - Tool plugin? See [Tool Plugins](/plugins/sdk-tool-plugins)
  - Channel plugin? See [Channel Plugins](/plugins/sdk-channel-plugins)
  - Provider plugin? See [Provider Plugins](/plugins/sdk-provider-plugins)
</Tip>

## Import convention

Always import from a specific subpath:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

// Deprecated — will be removed in the next major release
import { definePluginEntry } from "openclaw/plugin-sdk";
```

Each subpath is a small, self-contained module. This keeps startup fast and
prevents circular dependency issues.

For a short public import-path index, see [SDK Subpaths](/plugins/sdk-subpaths).

## Where imports usually start

| If you are building...          | Start here                         | Then read                                                                                                          |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| a tool, hook, or command plugin | `openclaw/plugin-sdk/plugin-entry` | [Tool Plugins](/plugins/sdk-tool-plugins)                                                                          |
| a channel plugin                | `openclaw/plugin-sdk/core`         | [Channel Plugins](/plugins/sdk-channel-plugins) and [Channel Plugin Interface](/plugins/sdk-channel-interface)     |
| a provider plugin               | `openclaw/plugin-sdk/plugin-entry` | [Provider Plugins](/plugins/sdk-provider-plugins) and [Provider Plugin Interface](/plugins/sdk-provider-interface) |
| setup/config surfaces           | `openclaw/plugin-sdk/core`         | [Plugin Setup and Config](/plugins/sdk-setup)                                                                      |
| test helpers                    | `openclaw/plugin-sdk/testing`      | [Testing](/plugins/sdk-testing)                                                                                    |

Use the task-specific guides to choose the supporting imports for that job.

## Registration API

The `register(api)` callback receives an `OpenClawPluginApi` object with these
methods:

### Capability registration

| Method                                        | What it registers              |
| --------------------------------------------- | ------------------------------ |
| `api.registerProvider(...)`                   | Text inference (LLM)           |
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

### API object fields

| Field                    | Type                      | Description                                               |
| ------------------------ | ------------------------- | --------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                 |
| `api.name`               | `string`                  | Display name                                              |
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

- [SDK Subpaths](/plugins/sdk-subpaths) — supported public import paths
- [Entry Points](/plugins/sdk-entrypoints) — `definePluginEntry` and `defineChannelPluginEntry` options
- [Channel Plugin Interface](/plugins/sdk-channel-interface) — public `ChannelPlugin` shape
- [Provider Plugin Interface](/plugins/sdk-provider-interface) — public `ProviderPlugin` shape
- [Runtime Helpers](/plugins/sdk-runtime) — full `api.runtime` namespace reference
- [Setup and Config](/plugins/sdk-setup) — packaging, manifests, config schemas
- [Testing](/plugins/sdk-testing) — test utilities and lint rules
- [Tool Plugins](/plugins/sdk-tool-plugins) — build tool, hook, and command plugins
- [SDK Migration](/plugins/sdk-migration) — migrating from deprecated surfaces
- [Plugin Internals](/plugins/architecture) — deep architecture and capability model
