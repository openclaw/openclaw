---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to add a new agent tool in a plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to make a tool opt-in via allowlists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Plugin Agent Tools"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Plugin agent tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw plugins can register **agent tools** (JSON‑schema functions) that are exposed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to the LLM during agent runs. Tools can be **required** (always available) or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**optional** (opt‑in).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent tools are configured under `tools` in the main config, or per‑agent under（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.list[].tools`. The allowlist/denylist policy controls which tools the agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
can call.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Basic tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { Type } from "@sinclair/typebox";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerTool({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name: "my_tool",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    description: "Do a thing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    parameters: Type.Object({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      input: Type.String(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    async execute(_id, params) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      return { content: [{ type: "text", text: params.input }] };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optional tool (opt‑in)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional tools are **never** auto‑enabled. Users must add them to an agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerTool(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      name: "workflow_tool",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      description: "Run a local workflow",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      parameters: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        type: "object",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        properties: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          pipeline: { type: "string" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        required: ["pipeline"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      async execute(_id, params) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        return { content: [{ type: "text", text: params.pipeline }] };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { optional: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  );（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable optional tools in `agents.list[].tools.allow` (or global `tools.allow`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "workflow_tool", // specific tool name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "workflow", // plugin id (enables all tools from that plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "group:plugins", // all plugin tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Other config knobs that affect tool availability:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowlists that only name plugin tools are treated as plugin opt-ins; core tools remain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  enabled unless you also include core tools or groups in the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.profile` / `agents.list[].tools.profile` (base allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider‑specific allow/deny)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.sandbox.tools.*` (sandbox tool policy when sandboxed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rules + tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool names must **not** clash with core tool names; conflicting tools are skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin ids used in allowlists must not clash with core tool names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `optional: true` for tools that trigger side effects or require extra（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  binaries/credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
