---
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists)"
read_when:
  - You want to add a new agent tool in a plugin
  - You need to make a tool opt-in via allowlists
---
# Plugin agent tools

Clawdbot plugins can register agent tools (JSON‑schema functions) that appear in the
agent tool list. Tools can be **required** (always available) or **optional** (opt‑in).

## Basic tool

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Optional tool (opt‑in)

Optional tools are **never** auto‑enabled. Users must add them to an agent
allowlist.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Enable optional tools in `agents.list[].tools.allow`:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool",  // specific tool name
            "workflow",       // plugin id (enables all tools from that plugin)
            "group:plugins"   // all plugin tools
          ]
        }
      }
    ]
  }
}
```

## Rules + tips

- Tool names must **not** clash with core tool names; conflicting tools are skipped.
- Plugin ids used in allowlists must not clash with core tool names.
- Prefer `optional: true` for tools that trigger side effects or require extra
  binaries/credentials.
