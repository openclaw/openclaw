---
summary: "Registering agent tools, custom commands, node-host commands, and widget presenters"
title: "Plugin SDK tools and commands"
sidebarTitle: "Tools and commands"
read_when:
  - You are registering an agent tool or a custom command
  - You are exposing a node-host command as an agent tool
  - You are registering a widget presenter or Computer Use provider
---

Registrars for agent-visible tools, custom commands, node-host commands, and
widget presenters. Part of the [Plugin SDK overview](/plugins/sdk-overview).

## Tools and commands

Use [`defineToolPlugin`](/plugins/tool-plugins) for simple tool-only plugins
with fixed tool names. Use `api.registerTool(...)` directly for mixed plugins
or fully dynamic tool registration.

When OpenClaw invokes a plugin tool with an `AbortSignal` inside a managed
operation, cancellation callbacks retain the executing plugin's runtime context
and the original cancellation reason. The tool can return a result before
already-started SDK work finishes; that work remains owned until its cleanup
settles. Cancellation cleanup does not authorize a new invocation after the
plugin or operation has closed. Return or join background work your tool starts
outside SDK-managed operations. Direct programmatic callers without a managed
operation continue to own their signal and work lifetime.

| Method                                   | What it registers                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `api.registerTool(tool, opts?)`          | Agent tool (required or `{ optional: true }`)                                                                                            |
| `api.registerCommand(def)`               | Custom command (bypasses the LLM)                                                                                                        |
| `api.registerNodeHostCommand(command)`   | Command handled by `openclaw node run`; optional `agentTool` metadata can expose it as an agent-visible tool while the node is connected |
| `api.registerWidgetPresenter(presenter)` | Explicit or current-channel destination behind the core `show_widget` tool                                                               |

Explicit widget presenters declare a unique model-visible target such as `node_panel`. Current-channel presenters use `target: "current_channel"`, provide a synchronous `match(context)` predicate over trusted delivery facts, and declare supported source kinds and delivery limits. Multiple transport presenters may coexist, but core selects an implicit route only when exactly one matches.

Core validates the shared `show_widget` schema, composes the bounded HTML document, and passes immutable HTML plus an optional hosted URL to `present(...)`. Presenters return either a generic message receipt or a node receipt. Expected availability and presentation failures use the closed error result instead of throwing; core falls back inline only for an actual `inline-widgets` client and otherwise surfaces the failure.

Computer Use providers use `registerComputerUseProvider(api, provider)` from
`openclaw/plugin-sdk/computer-use`. It registers the shared
`screen.snapshot`/`computer.act` node-host envelope once while the provider
keeps its driver, frame, availability, and execution lifecycle local.
Its optional `prepare(context)` hook settles native startup before the node's
first capability declaration, without opening a Computer Use execution.

Plugin commands can set `agentPromptGuidance` when the agent needs a short,
command-owned routing hint. Keep that text about the command itself; do not add
provider- or plugin-specific policy to core prompt builders.

A command handler that sends its own response can return `{ suppressReply: true }`:
OpenClaw then sends no reply of its own for that command, neither the result text
nor a missing-reply notice.

A command can hand the turn to the agent instead of replying. `{ continueAgent: true }`
runs the agent on the original message. `{ continueAgent: { prompt } }` sends `prompt` to
the model as this turn's message, the same way core `/learn` rewrites its turn. Earlier
history is not changed. Use this for commands that turn a short slash command into a
longer model request:

```ts
api.registerCommand({
  name: "recall",
  description: "Recall what we did",
  acceptsArgs: true,
  handler: async (ctx) =>
    ctx.args?.trim() === "list"
      ? { text: "Nothing saved yet." }
      : {
          continueAgent: {
            prompt: `Recall request (JSON string): ${JSON.stringify(ctx.args ?? "")}`,
          },
        },
});
```

Treat user arguments as data inside the prompt (for example, JSON-quote them). An
empty `prompt` fails the command. Continuation works for text commands and native
slash commands; scheduled command turns refuse it.

What the transcript shows follows the turn's committed input, exactly as for core
`/learn`. When the typed input is already committed before the command runs (Gateway
chat input, or any command that declares `runtimeCapabilities: ["subagents"]`, which
commits its input before exposing subagents), the user record keeps the typed command
and stores `prompt` as its model projection; replay sends the model the projection.
Otherwise the user record is `prompt` itself.

Channels that run native commands themselves call `dispatch.execute(...)`. When
`pluginCommandResultContinuesAgent(result)` (from `openclaw/plugin-sdk/plugin-command-runtime`)
is true, they skip their own reply and pass the same dispatch to the reply pipeline as the
planned plugin command decision. The pipeline then applies the result once, without running
the command again. Before it does, the pipeline checks the command's authorization
(`requireAuth`, `requiredScopes`) again against the reply turn's current requester facts,
so a requester whose access changed after the handler returned is refused before any
model or tool work.

Commands that receive `senderIsOwner` also receive the host's optional
`assertOwnerCurrent` callback when admitted as an owner. Capture that callback
before awaiting preparation and pass it to the mutation owner's current-authority
check. A boolean owner snapshot does not authorize a later write after the
linked profile is demoted, unlinked, or reassigned. The callback is bound to the
original identity and command invocation; retaining it cannot start new work
after the handler returns. Already accepted operations still finish their
settlement and cleanup. Ordinary authorized read commands and explicit Gateway
scope checks retain their existing behavior.

### Effects tied to a plugin conversation assignment

Commands and version-2 tool contexts expose the optional
`withCurrentConversationBinding` capability on supporting hosts. It runs one
async callback with a version-1 `PluginConversationBindingAuthority`: the
host-authenticated channel requester, canonical conversation/account/thread,
session incarnation, plugin binding, synchronous `assertCurrent`, and an opaque
`conversationBindingCurrent` restriction for the V2 state writer.

A binding snapshot from `getCurrentConversationBinding()`, an allowlist boolean,
owner status, session-key text, or model-supplied actor ID is not this capability.
The capability does not grant owner privileges or application membership.
For a linked requester, command admission retains the original host profile and
its current role authority before awaiting command preparation. Unlinking or
reassigning the same transport sender ID during that preparation invalidates the
original admission even if the sender string remains allowlisted; a stale linked
requester does not become an invocation with no linked profile. Native
command adapters keep their own command-policy checks while sharing this
requester-current restriction.

```typescript
if (!ctx.withCurrentConversationBinding) {
  throw new Error("This host cannot guard conversation-bound effects");
}
return ctx.withCurrentConversationBinding(async (authority) => {
  const actionStore = api.runtime.state.openKeyedStoreV2<GameState>(
    { namespace: "games", retention: "retained" },
    {
      ...authority,
      assertCurrent: () => {
        authority.assertCurrent();
        assertPlayerAllowed(authority.requester);
      },
    },
  );
  const observed = await actionStore.observe("current-game");
  const next = prepareMove(observed.value, authority.requester);
  return actionStore.compareAndApply("current-game", observed.comparison, {
    operation: "update",
    action: "set",
    value: next,
  });
});
```

Keep the opaque restriction and session-entry predicate when composing authority;
passing only an earlier snapshot or a replacement no-op assertion is insufficient.
Application membership and actor ownership must be checked against current state
inside the application owner's conditional mutation or worker operation. On a
comparison conflict, reread all preparation inputs and recheck authority; never
retry an unknown or already committed mutation.

This first contract supports authenticated channel participants with a live host
command/tool assertion, an existing session, and a core/native binding owner.
Binding and plugin-state effects must use the same physical shared-state store.
Custom/legacy adapter snapshots, missing identities, background owner
continuations without an exact conversation, and Control UI/guest principals
without a native channel requester are refused. No channel allowlist, mention
policy, owner-only command gate, or plugin permission is changed.

The assertion fails after detach/rebind, session replacement, revocation,
plugin retirement, callback return, or invocation closure. A detach followed by
reattachment cannot revive an old callback even when the binding ID is reused.
The native writer also compares the exact binding and expiry inside its write
transaction after the final host commit grant. Unsupported storage owners do
not fall back to a preliminary read. Host authority retains V2's existing
[commit-grant ordering](/plugins/sdk-runtime/state-and-system): a later revocation
does not undo an already accepted write. Await accepted work before leaving the
callback, preserve its receipt, and recheck authority before another external
effect. This is SDK boundary coverage, not proof of any application's multiplayer
behavior.

For native Discord commands, OpenClaw lowercases the selected command name and
skips names longer than 32 characters with a diagnostic. Use
`nativeNames: { discord: "short-name" }` when the primary name is longer. Slack
retains its selected alias spelling.

Commands may also declare a bounded client presentation action for parsed no-argument
invocations:

```ts
api.registerCommand({
  name: "pair",
  description: "Connect a device",
  clientPresentation: {
    when: "no-arguments",
    action: { kind: "device-pairing" },
  },
  handler: async () => ({ text: "ok" }),
});
```

The action union is closed and intentionally does not accept routes, callbacks,
URLs, or arbitrary client data. Supporting clients handle the action only when
they can complete it; otherwise the command follows its normal remote path.
This metadata expresses presentation intent, not authorization: the Gateway
remains authoritative for every RPC the client flow performs.

Guidance entries may be legacy strings, which apply to every prompt surface, or
structured entries:

```ts
api.registerCommand({
  name: "demo_cmd",
  description: "Demo command",
  agentPromptGuidance: [
    "Global command hint.",
    { text: "Only show this in the main OpenClaw prompt.", surfaces: ["openclaw_main"] },
  ],
  handler: async () => ({ text: "ok" }),
});
```

Structured `surfaces` may include `openclaw_main`, `codex_app_server`,
`cli_backend`, `acp_backend`, or `subagent`. `pi_main` remains a deprecated alias
for `openclaw_main`; the compatibility registry deprecated it on 2026-07-25 with
a `removeAfter` date of 2026-10-01 (see the
[removal timeline](/plugins/sdk-migration/removal-timeline)). Omit `surfaces` for
intentional all-surface guidance. Do
not pass an empty `surfaces` array; it is rejected so accidental scope loss does
not become global prompt text.

Native Codex app-server developer instructions are stricter than other prompt
surfaces: only guidance explicitly scoped to `codex_app_server` is promoted into
that higher-priority lane. Legacy string guidance and unscoped structured
guidance remain available to non-Codex prompt surfaces for compatibility.

Node-host commands run on the connected node host, not inside the Gateway
process. If `agentTool` is present, the node publishes a descriptor after a
successful Gateway connect; the Gateway exposes it to agent runs only while that
node is connected and only if the descriptor's `command` is in the node's
approved command surface. Set `agentTool.defaultPlatforms` to opt a
non-dangerous command into the default node command allowlist; otherwise require
explicit `gateway.nodes.commands.allow` or a node-invoke policy. `agentTool.name`
must be provider-safe: start with a letter, use only letters, digits,
underscores, or hyphens, and stay within 64 characters. MCP-backed node tools
can set `agentTool.mcp` metadata so catalog and tool-search surfaces can show
the remote MCP server/tool identity, but execution still goes through the
advertised node command.

Node-host commands must provide `hasActiveWork(): boolean` to allow automatic node
updates. Read already-owned state synchronously and return `false` only when
background processes, retained streams, and their cleanup have settled. Commands
whose work finishes within `handle(...)` can declare `hasActiveWork: () => false`;
the node host separately tracks in-flight invocations.
`createSessionCatalogNodeHostBindings` forwards its `hasActiveWork` option to
each generated command.

An absent hook, a thrown error, or any result other than `false` defers activation.
This preserves work owned by older plugins that predate the idle hook. The query
also runs for unavailable commands because availability can change while work is
still retained. Keep teardown in the command's existing lifecycle, such as
`onDisconnect`, and report idle only after that work settles. `onDisconnect` alone
does not establish idleness. Update older plugins to add the hook or use
`openclaw update` and an operator-controlled node restart.

ACP-backed catalogs can use `createAcpSessionCatalogAdoption` from
the private-local `openclaw/plugin-sdk/session-catalog-runtime` to share
adopted-session lookup and creation. Supply the catalog ID, local host ID,
session-key prefix, plugin marker keys, and transcript reader. The helper preserves
the marker shape, creates the ACP binding, and imports history before the session
entry finishes initialization.

Append-only JSONL catalogs can use `readSessionCatalogJsonlActivity` from the same
private runtime seam for bounded upstream activity reads. The helper owns file
opening, the one-MiB scan window, and offset advancement; the catalog classifies
complete rows and retains its own timestamp and user-message semantics.
