---
title: "Arven Memory"
summary: "Use Arven Memory as an OpenClaw memory slot through the bundled MCP adapter"
read_when:
  - You want OpenClaw's memory dropdown to include Arven Memory
  - You want legacy memory provider configs to point at Arven Memory
  - You need a memory backend that survives OpenClaw UI updates
---

# Arven Memory

The bundled `arven-memory` plugin lets OpenClaw use an Arven Memory MCP bridge
as the active memory slot. It is intentionally implemented as a normal plugin,
not a UI patch, so provider selection keeps working when OpenClaw UI surfaces
change.

## Configuration

Point the plugin at the Arven HTTP MCP endpoint and select it as the memory
slot:

```json5
{
  plugins: {
    entries: {
      "arven-memory": {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:8765/mcp",
          authHeaderEnv: "ARVEN_MEMORY_AUTH_HEADER", // optional
        },
      },
    },
    slots: {
      memory: "arven-memory",
    },
  },
}
```

The plugin registers `arven_memory_recall`, `arven_memory_get`,
`arven_memory_store`, and `arven_memory_status`. It also aliases recall/get to
the standard `memory_search` and `memory_get` tool names so agents can keep
using the normal memory tool surface when the Arven slot is selected.

## Bridge tool names

By default, the adapter calls these MCP tools on the configured endpoint:

| Adapter action | MCP tool        |
| -------------- | --------------- |
| Recall         | `memory_search` |
| Get            | `memory_get`    |
| Store          | `memory_store`  |
| Status         | `memory_status` |

If the Arven bridge exposes different names, override them in plugin config:

```json5
{
  plugins: {
    entries: {
      "arven-memory": {
        config: {
          baseUrl: "http://127.0.0.1:8765/mcp",
          recallTool: "arven_recall",
          getTool: "arven_get",
          storeTool: "arven_store",
          statusTool: "arven_status",
        },
      },
    },
    slots: { memory: "arven-memory" },
  },
}
```

## Legacy provider compatibility

For configs or migrations that previously used a memory provider string, map
the provider to the OpenClaw slot instead of editing the dropdown:

| Provider value | OpenClaw slot config                    |
| -------------- | --------------------------------------- |
| `arven`        | `plugins.slots.memory = "arven-memory"` |
| `arven-memory` | `plugins.slots.memory = "arven-memory"` |

This keeps the integration update-agnostic: importers can continue to emit a
provider label, while OpenClaw resolves the active backend through the plugin
manifest and slot registry.
