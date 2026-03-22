---
title: "Plugin Entry Points"
sidebarTitle: "Entry Points"
summary: "How to define plugin entry files for provider, tool, channel, and setup plugins"
read_when:
  - You are writing a plugin `index.ts`
  - You need to choose between `definePluginEntry` and `defineChannelPluginEntry`
  - You are adding a separate `setup-entry.ts`
---

# Plugin Entry Points

OpenClaw has two main entry helpers:

- `definePluginEntry(...)` for general plugins
- `defineChannelPluginEntry(...)` for native messaging channels

There is also `defineSetupPluginEntry(...)` for a separate setup-only module.

## `definePluginEntry(...)`

Use this for providers, tools, commands, services, memory plugins, and context
engines.

```ts
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "example-tools",
  name: "Example Tools",
  description: "Adds a command and a tool",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "example",
      description: "Show plugin status",
      handler: async () => ({ text: "example ok" }),
    });

    api.registerTool({
      name: "example_lookup",
      description: "Look up Example data",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      async execute(_callId, params) {
        return {
          content: [{ type: "text", text: `lookup: ${String(params.query)}` }],
        };
      },
    });
  },
});
```

## `defineChannelPluginEntry(...)`

Use this for a plugin that registers a `ChannelPlugin`.

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { channelPlugin } from "./src/channel.js";
import { setRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "example-channel",
  name: "Example Channel",
  description: "Example messaging plugin",
  plugin: channelPlugin,
  setRuntime,
  registerFull(api) {
    api.registerTool({
      name: "example_channel_status",
      description: "Inspect Example Channel state",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
  },
});
```

### Why `registerFull(...)` exists

OpenClaw can load plugins in setup-focused registration modes. `registerFull`
lets a channel plugin skip extra runtime-only registrations such as tools while
still registering the channel capability itself.

Use it for:

- agent tools
- gateway-only routes
- runtime-only commands

Do not use it for the actual `ChannelPlugin`; that belongs in `plugin: ...`.

## `defineSetupPluginEntry(...)`

Use this when a channel ships a second module for setup flows.

```ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { exampleSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(exampleSetupPlugin);
```

This keeps the setup entry shape explicit and matches the bundled channel
pattern used in OpenClaw.

## One plugin, many capabilities

A single entry file can register multiple capabilities:

```ts
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "example-hybrid",
  name: "Example Hybrid",
  description: "Provider plus tools",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: "example",
      label: "Example",
      auth: [],
    });

    api.registerTool({
      name: "example_ping",
      description: "Simple health check",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "pong" }] };
      },
    });
  },
});
```

## Entry-file checklist

- Give the plugin a stable `id`.
- Keep `name` and `description` human-readable.
- Put schema at the entry level when the plugin has config.
- Register only public capabilities inside `register(api)`.
- Keep channel plugins on `plugin-sdk/core`.
- Keep non-channel plugins on `plugin-sdk/plugin-entry`.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Runtime](/plugins/sdk-runtime)
- [Channel Plugin SDK](/plugins/sdk-channel-plugins)
- [Provider Plugin SDK](/plugins/sdk-provider-plugins)
