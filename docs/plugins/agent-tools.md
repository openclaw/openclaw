---
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists, lifecycle hooks)"
read_when:
  - You want to add a new agent tool in a plugin
  - You need to make a tool opt-in via allowlists
  - You want to intercept, block, or inject synthetic results for any tool call
title: "Plugin Agent Tools"
---

# Plugin agent tools

OpenClaw plugins can register **agent tools** (JSON‑schema functions) that are exposed
to the LLM during agent runs. Tools can be **required** (always available) or
**optional** (opt‑in).

Agent tools are configured under `tools` in the main config, or per‑agent under
`agents.list[].tools`. The allowlist/denylist policy controls which tools the agent
can call.

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

Enable optional tools in `agents.list[].tools.allow` (or global `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

Other config knobs that affect tool availability:

- Allowlists that only name plugin tools are treated as plugin opt-ins; core tools remain
  enabled unless you also include core tools or groups in the allowlist.
- `tools.profile` / `agents.list[].tools.profile` (base allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (provider‑specific allow/deny)
- `tools.sandbox.tools.*` (sandbox tool policy when sandboxed)

## Lifecycle hooks: intercept tool calls

Plugins can register `before_tool_call` and `after_tool_call` hooks to observe,
modify, block, or **short-circuit** any tool execution — including core tools and
other plugins' tools. Hooks fire for both the pi-agent and the AI SDK execution
engine.

```ts
export default function (api) {
  api.on("before_tool_call", async (event) => {
    const { toolName, params } = event;

    // 1. Observe without modifying — return nothing
    console.log("tool call incoming:", toolName);

    // 2. Modify parameters — return { params: { ...overrides } }
    if (toolName === "web_search") {
      return { params: { ...params, count: 3 } };
    }

    // 3. Block the call — return { block: true, blockReason: "..." }
    if (toolName === "exec" && String(params.command).includes("rm -rf")) {
      return { block: true, blockReason: "Destructive command blocked by policy" };
    }

    // 4. Inject a synthetic result — skips real tool execution entirely
    if (toolName === "web_fetch" && params.url === "https://example.com") {
      return { syntheticResult: "Cached content for example.com" };
    }
  });

  api.on("after_tool_call", async (event) => {
    const { toolName, params, result, error, durationMs } = event;
    // Observe the result or error — return value is currently ignored
    console.log(`tool ${toolName} finished in ${durationMs}ms`, { result, error });
  });
}
```

### `before_tool_call` return values

| Field             | Type      | Effect                                                            |
| ----------------- | --------- | ----------------------------------------------------------------- |
| _(nothing)_       |           | Allow the call through unchanged                                  |
| `params`          | `object`  | Replace or merge tool call parameters before execution            |
| `block`           | `boolean` | Block the call; LLM sees an error with `blockReason`              |
| `blockReason`     | `string`  | Human-readable reason returned to the LLM as a tool error         |
| `syntheticResult` | `unknown` | Skip real tool execution and return this value as the tool result |

`syntheticResult` takes precedence over `block` when both are set. Useful for
caching, mocking, redirecting tool calls to an alternative implementation, or
applying guardrail decisions with a custom result.

### `after_tool_call` event fields

| Field        | Type      | Description                             |
| ------------ | --------- | --------------------------------------- |
| `toolName`   | `string`  | Name of the tool that ran               |
| `params`     | `unknown` | Parameters that were passed to the tool |
| `result`     | `unknown` | Tool result (set on success)            |
| `error`      | `string`  | Error message (set on failure or block) |
| `durationMs` | `number`  | Elapsed time in milliseconds            |

### Hook priority

Multiple plugins can register `before_tool_call` and `after_tool_call` hooks. Hooks
run by descending `priority` (higher runs first). Pass a priority option to control order:

```ts
api.on("before_tool_call", handler, { priority: 80 });
```

Default priority is `50`. If any `before_tool_call` hook blocks or injects a
`syntheticResult`, later hooks in the same stage do not run.

## Rules + tips

- Tool names must **not** clash with core tool names; conflicting tools are skipped.
- Plugin ids used in allowlists must not clash with core tool names.
- Prefer `optional: true` for tools that trigger side effects or require extra
  binaries/credentials.
- Lifecycle hooks fire for **all** agent tools, not just those registered by your plugin.
  Be precise in your `toolName` checks to avoid unintended interference.
