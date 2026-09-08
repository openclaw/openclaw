---
summary: "Gate, rewrite, and approve tool calls, and rewrite tool results before persistence"
read_when:
  - You need to block a tool call or require approval from a plugin
  - You are writing sender-aware tool policy in a standalone plugin file
  - You are contributing environment variables to the exec tool
  - You are rewriting or blocking a transcript write
title: "Tool call policy hooks"
sidebarTitle: "Tool policy"
---

Tool-side hooks: parameter rewrites, blocks, approvals, exec environment
contributions, and transcript persistence. Part of the [Plugin hooks](/plugins/hooks) guide.

## Tool call policy

`before_tool_call` receives:

- `event.toolName`
- `event.params`
- optional `event.toolKind` and `event.toolInputKind`, host-authoritative
  discriminators for tools that intentionally share names; for example, outer
  code-mode `exec` calls use `toolKind: "code_mode_exec"` and include
  `toolInputKind: "javascript" | "typescript"` when the input language is
  known
- optional `event.derivedPaths`, best-effort host-derived target path hints
  for well-known tool envelopes such as `apply_patch`; these paths may be
  incomplete or over-approximate what the tool will actually touch (for
  example, with malformed or partial inputs)
- optional `event.runId`
- optional `event.toolCallId`
- context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`,
  `ctx.runId`, `ctx.toolKind`, `ctx.toolInputKind`, and diagnostic `ctx.trace`
- optional `ctx.abortSignal`, which aborts when the owning tool call is
  cancelled; handlers should pass it to cancellable I/O and remove any
  listeners they register
- optional `ctx.requester`, the host-derived requester that initiated the current
  message run. It can include `channel`, `accountId`, `senderId`,
  `senderIsOwner`, and provider-native `roleIds`. Missing fields are unproven,
  not false assurances; fail closed when policy requires them.

It can return:

```typescript
type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    scope?: ApprovalScope;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    /** @deprecated Unresolved approvals always deny. */
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (
      decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
    ) => Promise<void> | void;
  };
};
```

Guard behavior for typed lifecycle hooks:

- `block: true` is terminal and skips lower-priority handlers.
- `block: false` is treated as no decision.
- Return `params` to rewrite host-owned tool parameters. Each handler sees an
  isolated copy of the original event, not prior returned rewrites. The last
  returned `params` wins until an approval is requested.
- The first `requireApproval` wins, and its plugin id is stamped by the host.
  It freezes the selected parameter snapshot: later handlers can block but
  cannot change the approved parameters.
- Native tool relays can have narrower contracts. Codex native tools support
  blocking and observation, but parameter rewrites are rejected; see
  [Codex hook boundaries](/plugins/codex-harness-runtime#hook-boundaries).
- `requireApproval` pauses the agent run and asks the user through plugin
  approvals. `/approve` can approve both exec and plugin approvals. In Codex
  app-server report-mode native `PreToolUse` relays, this defers to the
  matching app-server approval request; see
  [Codex harness runtime](/plugins/codex-harness-runtime#hook-boundaries).
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.
- `onResolution` receives the resolved decision: `allow-once`, `allow-always`,
  `deny`, `timeout`, or `cancelled`.

For example, add this inside `register(api)` to ask before a host-owned
`exec` call. No conversation-access opt-in is needed for `before_tool_call`:

```typescript
api.on(
  "before_tool_call",
  () => ({
    requireApproval: {
      title: "Run command",
      description: "Allow this exec tool call?",
      severity: "info",
      timeoutMs: 60_000,
    },
  }),
  { matcher: ["exec"], priority: 50 },
);
```

### Sender-aware policy in one file

A standalone plugin file can keep deployment-specific policy in code instead
of adding another configuration schema. This example gives owners every tool,
lets configured maintainers use a conservative tool and message-action set,
and exposes `/fix` to senders already authorized by the channel configuration:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const AGENT_ID = "maintenance-agent";
const MAINTAINER_SCOPES = [
  {
    channel: "discord",
    accountId: "operations",
    senderIds: new Set(["maintainer-user-id"]),
    roleIds: new Set(["maintainer-role-id"]),
  },
];
const MAINTAINER_TOOLS = new Set(["read", "web_fetch", "web_search", "session_status", "message"]);
const MAINTAINER_MESSAGE_ACTIONS = new Set(["react", "reply", "thread-create", "thread-reply"]);

export default definePluginEntry({
  id: "maintenance-access",
  name: "Maintenance access",
  description: "Apply sender-aware tool policy to the maintenance agent.",
  register(api) {
    api.on("before_tool_call", (event, ctx) => {
      if (ctx.agentId !== AGENT_ID) {
        return;
      }

      const requester = ctx.requester;
      if (requester?.senderIsOwner === true) {
        return;
      }

      const maintainerScope = requester
        ? MAINTAINER_SCOPES.find(
            (scope) =>
              scope.channel === requester.channel && scope.accountId === requester.accountId,
          )
        : undefined;
      const isMaintainer =
        maintainerScope !== undefined &&
        ((requester?.senderId !== undefined && maintainerScope.senderIds.has(requester.senderId)) ||
          requester?.roleIds?.some((roleId) => maintainerScope.roleIds.has(roleId)) === true);
      if (!isMaintainer) {
        return { block: true, blockReason: "Maintainer access required." };
      }

      if (event.toolName === "message") {
        const action = typeof event.params.action === "string" ? event.params.action : "";
        if (MAINTAINER_MESSAGE_ACTIONS.has(action)) {
          return;
        }
        return { block: true, blockReason: `Owner required for message.${action || "unknown"}.` };
      }

      if (MAINTAINER_TOOLS.has(event.toolName)) {
        return;
      }
      return { block: true, blockReason: `Owner required for ${event.toolName}.` };
    });

    api.registerCommand({
      name: "fix",
      description: "Ask the maintenance agent to investigate and fix an issue.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) =>
        ctx.agentId === AGENT_ID
          ? { continueAgent: true }
          : { text: "This command is only available in the maintenance conversation." },
    });
  },
});
```

Load the file directly and restart the Gateway:

```json5
{
  agents: {
    entries: {
      "maintenance-agent": {
        default: true,
        workspace: "~/.openclaw/workspace-maintenance",
      },
    },
  },
  bindings: [
    {
      agentId: "maintenance-agent",
      match: {
        channel: "discord",
        accountId: "operations",
        peer: { kind: "channel", id: "maintenance-channel-id" },
      },
    },
  ],
  plugins: {
    load: { paths: ["~/.openclaw/policies/maintenance-access.ts"] },
  },
}
```

`AGENT_ID` must name the agent bound to the maintenance conversation. The
binding selects that agent for normal messages and `/fix`; the standalone file
remains the single owner of owner-versus-maintainer tool policy.

`requireAuth: true` reuses each channel's existing sender admission. For
Discord, a guild or channel `users`/`roles` allowlist can authorize the
maintenance audience. Other channels can use stable sender ids. The hook then
applies the finer per-tool decision on every tool call in the run, including
Codex native `PreToolUse` calls. It can veto a tool the model sees, but cannot
add a tool omitted by the host. Existing sandbox, exec approval, owner-only
core-tool, and channel policies still apply; the hook cannot grant past them.

Scope sender and role ids to an exact channel/account pair as shown; both are
provider-local namespaces. Keep the allowlists conservative. Add write or
execution tools only when the deployment's sandbox and approval policy make
that safe. For automated or system runs, decide explicitly whether an absent
`ctx.requester` should pass; the example denies it for the scoped agent.

See [Plugin permission requests](/plugins/plugin-permission-requests) for
approval routing, decision behavior, and when to use `requireApproval` instead
of optional tools or exec approvals.

Plugins that need host-level policy can register trusted tool policies with
`api.registerTrustedToolPolicy(...)`. These run before ordinary
`before_tool_call` hooks and before normal hook decisions. Bundled trusted
policies run first; installed-plugin trusted policies run next in plugin-load
order; ordinary `before_tool_call` hooks run after them. Bundled plugins keep
the existing trusted-policy path. Installed plugins must be explicitly enabled
and declare every policy id in `contracts.trustedToolPolicies`; undeclared ids
are rejected before registration. Policy ids are scoped to the registering
plugin, so different plugins may reuse the same local id. Use this tier only
for host-trusted gates such as workspace policy, budget enforcement, or
reserved workflow safety.

Trusted policies may set `matcher` to the same canonical tool-id list accepted
by `before_tool_call`. Omit the matcher to retain match-all behavior.

### Exec environment hook

`resolve_exec_env` lets plugins contribute environment variables to OpenClaw
`exec` tool invocations before the command runs. It is not a hook for every
harness-native shell. It receives:

- `event.sessionKey`
- `event.toolName`, currently always `"exec"`
- `event.host`, one of `"gateway"`, `"sandbox"`, or `"node"`
- context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`,
  `ctx.messageProvider`, and `ctx.channelId`

Return a `Record<string, string>` to merge into the exec environment. Handlers
run in priority order; later results override earlier results for the same
key.

Hook output is filtered through the host exec environment key policy before
merging. `PATH` is always dropped (command resolution and safe-bin checks
depend on it). Invalid keys and dangerous host override keys such as `LD_*`,
`DYLD_*`, `NODE_OPTIONS`, proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY`), and TLS override variables (`NODE_TLS_REJECT_UNAUTHORIZED`,
`SSL_CERT_FILE`, and similar) are dropped. The filtered plugin env is included
in Gateway approval/audit metadata and forwarded to node-host execution
requests.

### Tool result persistence

`tool_result_persist` and `before_message_write` are synchronous hooks. Do not
make their handlers `async`: returned promises are ignored with a warning.
Each handler receives the message returned by the previous handler.
`tool_result_persist` returns `{ message }` to replace a tool result;
`before_message_write` can return `{ message }` or `{ block: true }` to prevent
that transcript write. Blocking persistence is not a tool-execution veto.

These hooks operate on OpenClaw-owned transcript writes. They do not rewrite
Codex-native tool records; see
[Codex transcript boundaries](/plugins/codex-harness-runtime#compaction-and-transcript-mirror).

Tool results can include structured `details` for UI rendering, diagnostics,
media routing, or plugin-owned metadata. Treat `details` as runtime metadata,
not prompt content:

- OpenClaw strips `toolResult.details` before provider replay and compaction
  input so metadata does not become model context.
- Persisted session entries keep only bounded `details`. Oversized details are
  replaced with a compact summary and `persistedDetailsTruncated: true`.
- `tool_result_persist` and `before_message_write` run before the final
  persistence cap. Keep returned `details` small and avoid placing
  prompt-relevant text only in `details`; put model-visible tool output in
  `content`.
