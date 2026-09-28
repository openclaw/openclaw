---
summary: "The lightweight setup entry helper and the narrow setup helper families"
title: "Plugin SDK defineSetupPluginEntry helper"
sidebarTitle: "defineSetupPluginEntry"
read_when:
  - You are writing a setup-entry.ts file
  - You need the narrow setup, archive, or secret-file helper imports
---

The entry helper for the lightweight `setup-entry.ts` file, and the narrow
setup helper families that pair with it. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## `defineSetupPluginEntry`

**Import:** `openclaw/plugin-sdk/channel-core`

For the lightweight `setup-entry.ts` file. Returns just `{ plugin }` with no
runtime or CLI wiring.

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineSetupPluginEntry(myChannelPlugin);
```

OpenClaw loads this instead of the full entry when a channel is disabled or
unconfigured. See
[Setup and Config](/plugins/sdk-setup#setup-entry) for when this matters.

Pair `defineSetupPluginEntry(...)` with the narrow setup helper families:

| Import                                  | Use for                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw/plugin-sdk/setup-runtime`     | Runtime-safe setup helpers: `createSetupTranslator`, import-safe setup patch adapters, lookup-note output, `promptResolvedAllowFrom`, `splitSetupEntries`, delegated setup proxies |
| `openclaw/plugin-sdk/channel-setup`     | Optional-install setup surfaces                                                                                                                                                    |
| `openclaw/plugin-sdk/channel-dm-policy` | Account-aware DM policy descriptors for setup flows                                                                                                                                |
| `openclaw/plugin-sdk/setup-tools`       | Setup/install CLI, archive, and docs helpers                                                                                                                                       |
| `openclaw/plugin-sdk/archive`           | Bounded TAR/gzip member inspection, archive extraction, and single-entry reads                                                                                                     |
| `openclaw/plugin-sdk/root-walk`         | Budgeted, root-bounded directory walking                                                                                                                                           |
| `openclaw/plugin-sdk/secret-file`       | Pinned secret reads and first-writer-wins creation                                                                                                                                 |

`inspectTarArchive({ archivePath, timeoutMs, limits, entryFilter, onFiltered })`
returns a bounded, frozen list of accepted `{ path, kind, size }` TAR/gzip members
without creating an extracted tree. It uses fs-safe's complete admission and
zero-strip extraction policy, not tar display output. Paths use the existing
canonical archive identity; LF and Unicode spelling are preserved. Use matching
filter/limit settings and retain or verify the same archive bytes for subsequent
extraction: inspection results are not reusable write authority. Only the resolved
result is complete-admission evidence; a filter callback can precede a later
policy failure. The member manifest does not synthesize implicit parent directories,
so whole-tree consumers must authorize those parent paths separately.

Keep heavy SDKs, CLI registration, and long-lived runtime services in the
full entry.

Bundled workspace channels that split setup and runtime surfaces can use
`defineBundledChannelSetupEntry(...)` from
`openclaw/plugin-sdk/channel-entry-contract` instead. It lets the setup
entry keep setup-safe plugin/secrets exports while still exposing a runtime
setter:

```typescript
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "myChannelPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMyChannelRuntime",
  },
  registerSetupRuntime(api) {
    api.registerHttpRoute({
      path: "/my-channel/events",
      auth: "plugin",
      handler: async (req, res) => {
        /* setup-safe route */
      },
    });
  },
});
```

Use this only when a setup flow truly needs a lightweight runtime setter or
setup-safe gateway surface for an unconfigured channel.
`registerSetupRuntime` runs only for `"setup-runtime"` loads; keep it
limited to config-only routes or methods required by that setup flow.
