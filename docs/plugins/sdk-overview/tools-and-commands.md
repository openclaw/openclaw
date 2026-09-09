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

| Method                                   | What it registers                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `api.registerTool(tool, opts?)`          | Agent tool (required or `{ optional: true }`)                                                                                            |
| `api.registerCommand(def)`               | Custom command (bypasses the LLM)                                                                                                        |
| `api.registerNodeHostCommand(command)`   | Command handled by `openclaw node run`; optional `agentTool` metadata can expose it as an agent-visible tool while the node is connected |
| `api.registerWidgetPresenter(presenter)` | Explicit or current-channel destination behind the core `show_widget` tool                                                               |

Explicit widget presenters declare a unique model-visible target such as `node_panel`. Current-channel presenters use `target: "current_channel"`, provide a synchronous `match(context)` predicate over trusted delivery facts, and declare supported source kinds and delivery limits. Multiple transport presenters may coexist, but core selects an implicit route only when exactly one matches.

Core validates the canonical `show_widget` schema, composes the bounded HTML document, and passes immutable HTML plus an optional hosted URL to `present(...)`. Presenters return either a generic message receipt or a node receipt. Expected availability and presentation failures use the closed error result instead of throwing; core falls back inline only for an actual `inline-widgets` client and otherwise surfaces the failure.

Computer Use providers use `registerComputerUseProvider(api, provider)` from
`openclaw/plugin-sdk/computer-use`. It registers the shared
`screen.snapshot`/`computer.act` node-host envelope once while the provider
keeps its driver, frame, availability, and execution lifecycle local.
Its optional `prepare(context)` hook settles native startup before the node's
first capability declaration, without opening a Computer Use execution.

Plugin commands can set `agentPromptGuidance` when the agent needs a short,
command-owned routing hint. Keep that text about the command itself; do not add
provider- or plugin-specific policy to core prompt builders.

Commands may also declare a bounded client presentation action for parsed no-argument
invocations:

```ts
clientPresentation: {
  when: "no-arguments",
  action: { kind: "device-pairing" },
}
```

The action union is closed and intentionally does not accept routes, callbacks,
URLs, or arbitrary client data. Supporting clients handle the action only when
they can complete it; otherwise the command follows its normal remote path.
This metadata expresses presentation intent, not authorization: the Gateway
remains authoritative for every RPC the client flow performs.

Guidance entries may be legacy strings, which apply to every prompt surface, or
structured entries:

```ts
agentPromptGuidance: [
  "Global command hint.",
  { text: "Only show this in the main OpenClaw prompt.", surfaces: ["openclaw_main"] },
];
```

Structured `surfaces` may include `openclaw_main`, `codex_app_server`,
`cli_backend`, `acp_backend`, or `subagent`. `pi_main` remains a deprecated alias
for `openclaw_main`. Omit `surfaces` for intentional all-surface guidance. Do
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
