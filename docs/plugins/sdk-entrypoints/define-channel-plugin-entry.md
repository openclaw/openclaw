---
summary: "The channel entry helper, its mode-gated callbacks, and CLI registration"
title: "Plugin SDK defineChannelPluginEntry helper"
sidebarTitle: "defineChannelPluginEntry"
read_when:
  - You are writing a messaging channel plugin
  - You need to know which callback runs in which registration mode
  - You are registering plugin-owned root CLI commands
---

The entry helper that wraps `definePluginEntry` with channel-specific wiring
and mode-gated callbacks. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## `defineChannelPluginEntry`

**Import:** `openclaw/plugin-sdk/channel-core`

Wraps `definePluginEntry` with channel-specific wiring: it automatically
calls `api.registerChannel({ plugin })`, exposes an optional root-help CLI
metadata seam, and gates capability and full-runtime callbacks on registration
mode.

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

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
  registerCapabilities(api) {
    api.registerTranscriptSourceProvider(/* ... */);
  },
});
```

| Field                  | Type                                                             | Required | Default             |
| ---------------------- | ---------------------------------------------------------------- | -------- | ------------------- |
| `id`                   | `string`                                                         | Yes      | -                   |
| `name`                 | `string`                                                         | Yes      | -                   |
| `description`          | `string`                                                         | Yes      | -                   |
| `plugin`               | `ChannelPlugin`                                                  | Yes      | -                   |
| `configSchema`         | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | No       | Empty object schema |
| `setRuntime`           | `(runtime: PluginRuntime) => void`                               | No       | -                   |
| `registerCliMetadata`  | `(api: OpenClawPluginApi) => void`                               | No       | -                   |
| `registerFull`         | `(api: OpenClawPluginApi) => void`                               | No       | -                   |
| `registerCapabilities` | `(api: OpenClawPluginApi) => void`                               | No       | -                   |

Callbacks run per registration mode (full table under
[Registration mode](/plugins/sdk-entrypoints/registration-mode#registration-mode)):

- `setRuntime` runs in every mode except `"cli-metadata"` and
  `"tool-discovery"`. Store the runtime reference here, typically via
  `createPluginRuntimeStore`.
- `registerCliMetadata` runs for `"cli-metadata"`, `"discovery"`, and
  `"full"`. Use it as the canonical place for channel-owned CLI descriptors
  so root help stays non-activating, discovery snapshots include static
  command metadata, and normal CLI registration stays compatible with full
  plugin loads.
- `registerFull` runs only for `"full"` and `"tool-discovery"`. For
  `"tool-discovery"` it runs _instead of_ channel registration: OpenClaw
  skips `registerChannel`/`setRuntime` entirely and calls the full-runtime
  callback followed by the capability callback. Keep tool registration in
  `registerFull` and capability providers in `registerCapabilities`.
- `registerCapabilities` runs for `"discovery"`, `"full"`, and
  `"tool-discovery"`. Register inert advertised providers here so read-only
  capability discovery can find them without starting sockets, clients,
  workers, or services.
- Discovery registration is non-activating, not import-free: OpenClaw may
  evaluate the trusted plugin entry and channel plugin module to build the
  snapshot. Keep top-level imports side-effect-free and put sockets,
  clients, workers, and services behind `"full"`-only paths.
- Like `definePluginEntry`, `configSchema` can be a lazy factory; OpenClaw
  memoizes the resolved schema on first access.

CLI registration:

- Use `api.registerCli(..., { descriptors: [...] })` for plugin-owned root
  CLI commands you want lazy-loaded without disappearing from the root CLI
  parse tree. Descriptor names must match letters, numbers, hyphen, and
  underscore, starting with a letter or number; OpenClaw rejects other
  shapes and strips terminal control sequences from descriptions before
  rendering help. Cover every top-level command root the registrar exposes,
  and declare the same name, description, and subcommand marker in the
  plugin manifest's `cliCommands` field so root help does not import plugin code.
  `commands` alone stays on the eager compatibility path.
- Root descriptors may define a synchronous, pure
  `machineOutput({ argv, stdoutIsTTY })` resolver for JSON, JSONL, or other
  machine-readable stdout modes that are not selected solely by `--json`.
  Parse command tokens with `getRootOptionAwareCommandPath` from
  `openclaw/plugin-sdk/cli-argv`. Keep the descriptor in a lightweight
  plugin-local module and reuse it from both `cli-metadata.ts` and full
  registration; do not import runtime barrels to construct metadata.
  Meeting runtime shells accept that descriptor through `cli.descriptor`.
  Nested descriptors do not expose `machineOutput`.
- Use `api.registerNodeCliFeature(...)` for paired-node feature commands so
  they land under `openclaw nodes` (equivalent to
  `registerCli(registrar, { parentPath: ["nodes"], ... })`).
- For other nested plugin commands, add `parentPath` and register commands
  on the `program` object passed to the registrar; OpenClaw resolves it to
  the parent command before calling the plugin.
- For channel plugins, register CLI descriptors from `registerCliMetadata`
  and keep `registerFull` focused on runtime-only work.
- If `registerFull` also registers gateway RPC methods, keep them on a
  plugin-specific prefix. Reserved core admin namespaces (`config.*`,
  `exec.approvals.*`, `wizard.*`, `update.*`) always coerce to
  `operator.admin`.
