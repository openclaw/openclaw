---
title: "Plugin Runtime"
sidebarTitle: "Runtime"
summary: "How `api.runtime` works, when to use it, and how to manage plugin runtime state safely"
read_when:
  - You need to call runtime helpers from a plugin
  - You are deciding between hooks and injected runtime
  - You need a safe module-level runtime store
---

# Plugin Runtime

Native OpenClaw plugins receive a trusted runtime through `api.runtime`.

Use it for **host-owned operations** that should stay inside OpenClaw’s runtime:

- reading and writing config
- agent/session helpers
- system commands with OpenClaw timeouts
- media, speech, image-generation, and web-search runtime calls
- channel-owned helpers for bundled channel plugins

## When to use runtime vs focused SDK helpers

- Use focused SDK helpers when a public subpath already models the job.
- Use `api.runtime.*` when the host owns the operation or state.
- Prefer hooks for loose integrations that do not need tight in-process access.

## Runtime namespaces

| Namespace                        | What it covers                                     |
| -------------------------------- | -------------------------------------------------- |
| `api.runtime.config`             | Load and persist OpenClaw config                   |
| `api.runtime.agent`              | Agent workspace, identity, timeouts, session store |
| `api.runtime.system`             | System events, heartbeats, command execution       |
| `api.runtime.media`              | File/media loading and transforms                  |
| `api.runtime.tts`                | Speech synthesis and voice listing                 |
| `api.runtime.mediaUnderstanding` | Image/audio/video understanding                    |
| `api.runtime.imageGeneration`    | Image generation providers                         |
| `api.runtime.webSearch`          | Runtime web-search execution                       |
| `api.runtime.modelAuth`          | Resolve model/provider credentials                 |
| `api.runtime.subagent`           | Spawn, wait, inspect, and delete subagent sessions |
| `api.runtime.channel`            | Channel-heavy helpers for native channel plugins   |

## Example: read and persist config

```ts
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "talk-settings",
  name: "Talk Settings",
  description: "Example runtime config write",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "talk-mode",
      description: "Enable talk mode",
      handler: async () => {
        const cfg = api.runtime.config.loadConfig();
        const nextConfig = {
          ...cfg,
          talk: {
            ...cfg.talk,
            enabled: true,
          },
        };
        await api.runtime.config.writeConfigFile(nextConfig);
        return { text: "talk mode enabled" };
      },
    });
  },
});
```

## Example: use a runtime service owned by OpenClaw

```ts
const cfg = api.runtime.config.loadConfig();
const voices = await api.runtime.tts.listVoices({
  provider: "openai",
  cfg,
});

return {
  text: voices.map((voice) => `${voice.name ?? voice.id}: ${voice.id}`).join("\n"),
};
```

## `createPluginRuntimeStore(...)`

Plugin modules often need a small mutable slot for runtime-backed helpers. Use
`plugin-sdk/runtime-store` instead of an unguarded `let runtime`.

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { channelPlugin } from "./src/channel.js";

const runtimeStore = createPluginRuntimeStore<{
  logger: { info(message: string): void };
}>("Example Channel runtime not initialized");

export function setExampleRuntime(runtime: { logger: { info(message: string): void } }) {
  runtimeStore.setRuntime(runtime);
}

export function getExampleRuntime() {
  return runtimeStore.getRuntime();
}

export default defineChannelPluginEntry({
  id: "example-channel",
  name: "Example Channel",
  description: "Example runtime store usage",
  plugin: channelPlugin,
  setRuntime: setExampleRuntime,
});
```

`createPluginRuntimeStore(...)` gives you:

- `setRuntime(next)`
- `clearRuntime()`
- `tryGetRuntime()`
- `getRuntime()`

`getRuntime()` throws with your custom message if the runtime was never set.

## Channel runtime note

`api.runtime.channel.*` is the heaviest namespace. It exists for native channel
plugins that need tight coupling with the OpenClaw messaging stack.

Prefer narrower subpaths such as:

- `plugin-sdk/channel-pairing`
- `plugin-sdk/channel-actions`
- `plugin-sdk/channel-feedback`
- `plugin-sdk/channel-lifecycle`

Use `api.runtime.channel.*` when the operation is clearly host-owned and there
is no smaller public seam.

## Runtime safety guidelines

- Do not cache config snapshots longer than needed.
- Prefer `createPluginRuntimeStore(...)` for shared module state.
- Keep runtime-backed code behind small local helpers.
- Avoid reaching into runtime namespaces you do not need.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Entry Points](/plugins/sdk-entrypoints)
- [Plugin Setup](/plugins/sdk-setup)
- [Channel Plugin SDK](/plugins/sdk-channel-plugins)
