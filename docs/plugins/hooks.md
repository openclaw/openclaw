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

## Hook catalog

Hooks are grouped by the surface they extend. Names in **bold** accept a
decision result (block, cancel, override, or require approval); all others are
observation-only.

**Agent turn**

- `before_model_resolve` — override provider or model before session messages load
- `before_prompt_build` — add dynamic context or system-prompt text before the model call
- `before_agent_start` — compatibility-only combined phase; prefer the two hooks above
- **`before_agent_reply`** — short-circuit the model turn with a synthetic reply or silence
- `agent_end` — observe final messages, success state, and run duration

**Conversation observation**

- `llm_input` — observe provider input (system prompt, prompt, history)
- `llm_output` — observe provider output

**Tools**

- **`before_tool_call`** — rewrite tool params, block execution, or require approval
- `after_tool_call` — observe tool results, errors, and duration
- **`tool_result_persist`** — rewrite the assistant message produced from a tool result
- **`before_message_write`** — inspect or block an in-progress message write (rare)

**Messages and delivery**

- **`inbound_claim`** — claim an inbound message before agent routing (synthetic replies)
- `message_received` — observe inbound content, sender, thread, and metadata
- **`message_sending`** — rewrite outbound content or cancel delivery
- `message_sent` — observe outbound delivery success or failure
- **`before_dispatch`** — inspect or rewrite an outbound dispatch before channel handoff
- **`reply_dispatch`** — participate in the final reply-dispatch pipeline

**Sessions and compaction**

- `session_start` / `session_end` — track session lifecycle boundaries
- `before_compaction` / `after_compaction` — observe or annotate compaction cycles
- `before_reset` — observe session-reset events (`/reset`, programmatic resets)

**Subagents**

- `subagent_spawning` / `subagent_delivery_target` / `subagent_spawned` / `subagent_ended` — coordinate subagent routing and completion delivery

**Lifecycle**

- `gateway_start` / `gateway_stop` — start or stop plugin-owned services with the Gateway
- **`before_install`** — inspect skill or plugin install scans and optionally block

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
    pluginId?: string;
    onResolution?: (
      decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
    ) => Promise<void> | void;
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
- `onResolution` receives the resolved approval decision — `allow-once`,
  `allow-always`, `deny`, `timeout`, or `cancelled`.

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
