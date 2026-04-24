---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
---

Plugin hooks are in-process extension points for OpenClaw plugins. Use them
when a plugin needs to inspect or change agent runs, tool calls, message flow,
session lifecycle, subagent routing, installs, or Gateway startup.

Use [internal hooks](/automation/hooks) instead when you want a small
operator-installed `HOOK.md` script for command and Gateway events such as
`/new`, `/reset`, `/stop`, `agent:bootstrap`, or `gateway:startup`.

## Quick start

Register typed plugin hooks with `api.on(...)` from your plugin entry:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "tool-preflight",
  name: "Tool Preflight",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        if (event.toolName !== "web_search") {
          return;
        }

        return {
          requireApproval: {
            title: "Run web search",
            description: `Allow search query: ${String(event.params.query ?? "")}`,
            severity: "info",
            timeoutMs: 60_000,
            timeoutBehavior: "deny",
          },
        };
      },
      { priority: 50 },
    );
  },
});
```

Hook handlers run sequentially in descending `priority`. Same-priority hooks
keep registration order.

## Common hooks

| Hook                                                                                     | Use it for                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `before_tool_call`                                                                       | Rewrite tool params, block execution, or request user approval before a tool runs. |
| `after_tool_call`                                                                        | Observe tool results, errors, and duration after execution.                        |
| `before_prompt_build`                                                                    | Add dynamic context or system prompt text before the model call.                   |
| `before_model_resolve`                                                                   | Override provider or model before session messages are loaded.                     |
| `before_agent_reply`                                                                     | Short-circuit the model turn with a synthetic reply or silence.                    |
| `llm_input` / `llm_output`                                                               | Observe provider input/output for conversation-aware plugins.                      |
| `agent_end`                                                                              | Observe final messages, success state, and run duration.                           |
| `message_received`                                                                       | Observe inbound channel messages after channel parsing.                            |
| `message_sending`                                                                        | Rewrite or cancel outbound channel messages.                                       |
| `message_sent`                                                                           | Observe outbound delivery success or failure.                                      |
| `session_start` / `session_end`                                                          | Track session lifecycle boundaries.                                                |
| `before_compaction` / `after_compaction`                                                 | Observe or annotate compaction cycles.                                             |
| `subagent_spawning` / `subagent_delivery_target` / `subagent_spawned` / `subagent_ended` | Coordinate subagent routing and completion delivery.                               |
| `gateway_start` / `gateway_stop`                                                         | Start or stop plugin services with the Gateway.                                    |
| `before_install`                                                                         | Inspect skill or plugin install scans and optionally block.                        |

## Tool call policy

`before_tool_call` receives:

- `event.toolName`
- `event.params`
- optional `event.runId`
- optional `event.toolCallId`
- context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`, and
  diagnostic `ctx.trace`

It can return:

```typescript
type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    onResolution?: (decision: string) => Promise<void> | void;
  };
};
```

Rules:

- `block: true` is terminal and skips lower-priority handlers.
- `block: false` is treated as no decision.
- `params` rewrites the tool parameters for execution.
- `requireApproval` pauses the agent run and asks the user through plugin
  approvals. The `/approve` command can approve both exec and plugin approvals.
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.

## Prompt and model hooks

Use the phase-specific hooks for new plugins:

- `before_model_resolve`: receives only the current prompt and attachment
  metadata. Return `providerOverride` or `modelOverride`.
- `before_prompt_build`: receives the current prompt and session messages.
  Return `prependContext`, `systemPrompt`, `prependSystemContext`, or
  `appendSystemContext`.

`before_agent_start` remains for compatibility. Prefer the explicit hooks above
so your plugin does not depend on a legacy combined phase.

Non-bundled plugins that need `llm_input`, `llm_output`, or `agent_end` must set:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Prompt-mutating hooks can be disabled per plugin with
`plugins.entries.<id>.hooks.allowPromptInjection=false`.

## Message hooks

Use message hooks for channel-level routing and delivery policy:

- `message_received`: observe inbound content, sender, `threadId`, and metadata.
- `message_sending`: rewrite `content` or return `{ cancel: true }`.
- `message_sent`: observe final success or failure.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- Rewritten `content` continues to lower-priority hooks unless a later hook
  cancels delivery.

## Install hooks

`before_install` runs after the built-in scan for skill and plugin installs.
Return additional findings or `{ block: true, blockReason }` to stop the
install.

`block: true` is terminal. `block: false` is treated as no decision.

## Gateway lifecycle

Use `gateway_start` for plugin services that need Gateway-owned state. The
context exposes `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()` for
cron inspection and updates. Use `gateway_stop` to clean up long-running
resources.

Do not rely on the internal `gateway:startup` hook for plugin-owned runtime
services.

## Related

- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Plugin architecture internals](/plugins/architecture-internals)
