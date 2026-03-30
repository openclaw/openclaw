---
title: "Plugin Entry Points"
sidebarTitle: "Entry Points"
summary: "Reference for definePluginEntry, defineChannelPluginEntry, and defineSetupPluginEntry"
read_when:
  - You need the exact type signature of definePluginEntry or defineChannelPluginEntry
  - You want to understand registration mode (full vs setup vs CLI metadata)
  - You are looking up entry point options
---

# Plugin Entry Points

Every plugin exports a default entry object. The SDK provides three helpers for
creating them.

<Tip>
  **Looking for a walkthrough?** See [Channel Plugins](/plugins/sdk-channel-plugins)
  or [Provider Plugins](/plugins/sdk-provider-plugins) for step-by-step guides.
</Tip>

## `definePluginEntry`

**Import:** `openclaw/plugin-sdk/plugin-entry`

For provider plugins, tool plugins, hook plugins, and anything that is **not**
a messaging channel.

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Short summary",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
  },
});
```

| Field          | Type                                                             | Required | Default             |
| -------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`           | `string`                                                         | Yes      | —                   |
| `name`         | `string`                                                         | Yes      | —                   |
| `description`  | `string`                                                         | Yes      | —                   |
| `kind`         | `string`                                                         | No       | —                   |
| `configSchema` | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `register`     | `(api: OpenClawPluginApi) => void`                               | Yes      | —                   |

- `id` must match your `openclaw.plugin.json` manifest.
- `kind` is for exclusive slots: `"memory"` or `"context-engine"`.
- `configSchema` can be a function for lazy evaluation.

## `defineChannelPluginEntry`

**Import:** `openclaw/plugin-sdk/core`

Wraps `definePluginEntry` with channel-specific wiring. Automatically calls
`api.registerChannel({ plugin })`, exposes an optional root-help CLI metadata
seam, and gates `registerFull` on registration mode.

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

export default defineChannelPluginEntry({
  id: "my-channel",
  name: "My Channel",
  description: "Short summary",
  plugin: myChannelPlugin,
  setRuntime: setMyRuntime,
  registerCliMetadata(api) {
    api.registerCli(/* ... */);
  },
  registerFull(api) {
    api.registerGatewayMethod(/* ... */);
  },
});
```

| Field                 | Type                                                             | Required | Default             |
| --------------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`                  | `string`                                                         | Yes      | —                   |
| `name`                | `string`                                                         | Yes      | —                   |
| `description`         | `string`                                                         | Yes      | —                   |
| `plugin`              | `ChannelPlugin`                                                  | Yes      | —                   |
| `configSchema`        | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `setRuntime`          | `(runtime: PluginRuntime) => void`                               | No       | —                   |
| `registerCliMetadata` | `(api: OpenClawPluginApi) => void`                               | No       | —                   |
| `registerFull`        | `(api: OpenClawPluginApi) => void`                               | No       | —                   |

- `setRuntime` is called during registration so you can store the runtime reference
  (typically via `createPluginRuntimeStore`). It is skipped during CLI metadata
  capture.
- `registerCliMetadata` runs during both `api.registrationMode === "cli-metadata"`
  and `api.registrationMode === "full"`.
  Use it as the canonical place for channel-owned CLI descriptors so root help
  stays non-activating while normal CLI command registration remains compatible
  with full plugin loads.
- `registerFull` only runs when `api.registrationMode === "full"`. It is skipped
  during setup-only loading.
- For plugin-owned root CLI commands, prefer `api.registerCli(..., { descriptors: [...] })`
  when you want the command to stay lazy-loaded without disappearing from the
  root CLI parse tree. For channel plugins, prefer registering those descriptors
  from `registerCliMetadata(...)` and keep `registerFull(...)` focused on runtime-only work.

## `defineSetupPluginEntry`

**Import:** `openclaw/plugin-sdk/core`

For the lightweight `setup-entry.ts` file. Returns just `{ plugin }` with no
runtime or CLI wiring.

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";

export default defineSetupPluginEntry(myChannelPlugin);
```

OpenClaw loads this instead of the full entry when a channel is disabled,
unconfigured, or when deferred loading is enabled. See
[Setup and Config](/plugins/sdk-setup#setup-entry) for when this matters.

## Registration mode

`api.registrationMode` tells your plugin how it was loaded:

| Mode              | When                              | What to register              |
| ----------------- | --------------------------------- | ----------------------------- |
| `"full"`          | Normal gateway startup            | Everything                    |
| `"setup-only"`    | Disabled/unconfigured channel     | Channel registration only     |
| `"setup-runtime"` | Setup flow with runtime available | Channel + lightweight runtime |
| `"cli-metadata"`  | Root help / CLI metadata capture  | CLI descriptors only          |

`defineChannelPluginEntry` handles this split automatically. If you use
`definePluginEntry` directly for a channel, check mode yourself:

```typescript
register(api) {
  if (api.registrationMode === "cli-metadata" || api.registrationMode === "full") {
    api.registerCli(/* ... */);
    if (api.registrationMode === "cli-metadata") return;
  }

  api.registerChannel({ plugin: myPlugin });
  if (api.registrationMode !== "full") return;

  // Heavy runtime-only registrations
  api.registerService(/* ... */);
}
```

For CLI registrars specifically:

- use `descriptors` when the registrar owns one or more root commands and you
  want OpenClaw to lazy-load the real CLI module on first invocation
- make sure those descriptors cover every top-level command root exposed by the
  registrar
- use `commands` alone only for eager compatibility paths

## Plugin shapes

OpenClaw classifies loaded plugins by their registration behavior:

| Shape                 | Description                                        |
| --------------------- | -------------------------------------------------- |
| **plain-capability**  | One capability type (e.g. provider-only)           |
| **hybrid-capability** | Multiple capability types (e.g. provider + speech) |
| **hook-only**         | Only hooks, no capabilities                        |
| **non-capability**    | Tools/commands/services but no capabilities        |

Use `openclaw plugins inspect <id>` to see a plugin's shape.

## Related

- [SDK Overview](/plugins/sdk-overview) — registration API and subpath reference
- [Runtime Helpers](/plugins/sdk-runtime) — `api.runtime` and `createPluginRuntimeStore`
- [Setup and Config](/plugins/sdk-setup) — manifest, setup entry, deferred loading
- [Channel Plugins](/plugins/sdk-channel-plugins) — building the `ChannelPlugin` object
- [Provider Plugins](/plugins/sdk-provider-plugins) — provider registration and hooks
