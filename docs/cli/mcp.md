---
summary: "Expose OpenClaw channel conversations over MCP and manage saved MCP server definitions"
read_when:
  - Connecting Codex, Claude Code, or another MCP client to OpenClaw-backed channels
  - Running `openclaw mcp serve`
  - Managing OpenClaw-saved MCP server definitions
title: "MCP"
sidebarTitle: "MCP"
---

`openclaw mcp` has two jobs:

- run OpenClaw as an MCP server with `openclaw mcp serve`
- manage OpenClaw-managed outbound MCP server definitions with `list`, `show`, `status`, `doctor`, `probe`, `add`, `set`, `configure`, `tools`, `login`, `logout`, `reload`, and `unset`

`serve` is OpenClaw acting as an MCP server. The other subcommands are OpenClaw acting as an MCP client-side registry for servers its own runtimes may consume later.

<Note>
  `list`, `show`, `set`, and `unset` only read and write OpenClaw-managed `mcp.servers` entries in OpenClaw config. They do not include mcporter servers from `config/mcporter.json`; use `mcporter list` for that registry.
</Note>

Use [`openclaw acp`](/cli/acp) when OpenClaw should host a coding harness session itself and route that runtime through ACP.

## Choose the right MCP path

| Goal                                                                | Use                                                                  | Why                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Let an external MCP client read/send OpenClaw channel conversations | `openclaw mcp serve`                                                 | OpenClaw is the MCP server and exposes Gateway-backed conversations over stdio.                                 |
| Save third-party MCP servers for OpenClaw-managed agent runs        | `openclaw mcp add`, `set`, `configure`, `tools`, `login`             | OpenClaw is the MCP client-side registry and later projects those servers into eligible runtimes.               |
| Check a saved server without running an agent turn                  | `openclaw mcp status`, `doctor`, `probe`                             | `status` and `doctor` inspect config; `probe` opens a live MCP connection and lists capabilities.               |
| Edit MCP config from a browser                                      | Control UI `/settings/mcp` (`/mcp` alias)                            | The page shows inventory, enablement, OAuth/filter summaries, command hints, and a scoped `mcp` editor.         |
| Give Codex app-server a scoped native MCP server                    | `mcp.servers.<name>.codex`                                           | The `codex` block only affects Codex app-server thread projection and is stripped before native config handoff. |
| Run ACP-hosted harness sessions                                     | [`openclaw acp`](/cli/acp) and [ACP Agents](/tools/acp-agents-setup) | ACP bridge mode does not accept per-session MCP server injection; configure gateway/plugin bridges instead.     |

<Tip>
If you are not sure which path you need, start with `openclaw mcp status --verbose`. It shows what OpenClaw has saved without starting any MCP servers.
</Tip>

## MCP pages

This page is an index. `openclaw mcp` has six pages, one per reader job. Open
the page that matches your task.

| Page                                            | Read it when                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Run OpenClaw as an MCP server](/cli/mcp/serve) | An MCP client should read or send OpenClaw channel conversations through `openclaw mcp serve`. |
| [Manage saved MCP servers](/cli/mcp/registry)   | You are saving, inspecting, or approving third-party MCP servers for OpenClaw-managed runs.    |
| [JSON output shapes](/cli/mcp/json-output)      | You are scripting against `status --json`, `doctor --json`, or `probe --json`.                 |
| [Transports and OAuth](/cli/mcp/transports)     | You need a transport config field, or you are running the MCP OAuth login flow.                |
| [MCP in the Control UI](/cli/mcp/control-ui)    | You want to edit or inspect MCP config from a browser.                                         |
| [MCP Apps](/cli/mcp/apps)                       | You are enabling or securing the MCP Apps host bridge.                                         |

## Where each section moved

Every anchor from the previous single-page version still resolves here, so an
existing link such as `/cli/mcp#bridge-tools` keeps working. Each entry points at
the page that now holds the content.

- <a id="openclaw-as-an-mcp-server" />[OpenClaw as an MCP server](/cli/mcp/serve#openclaw-as-an-mcp-server)
- <a id="when-to-use-serve" />[When to use serve](/cli/mcp/serve#when-to-use-serve)
- <a id="how-it-works" />[How it works](/cli/mcp/serve#how-it-works)
- <a id="client-spawns-the-bridge" />[Client spawns the bridge](/cli/mcp/serve#client-spawns-the-bridge)
- <a id="bridge-connects-to-gateway" />[Bridge connects to Gateway](/cli/mcp/serve#bridge-connects-to-gateway)
- <a id="sessions-become-mcp-conversations" />[Sessions become MCP conversations](/cli/mcp/serve#sessions-become-mcp-conversations)
- <a id="live-events-queue" />[Live events queue](/cli/mcp/serve#live-events-queue)
- <a id="optional-claude-push" />[Optional Claude push](/cli/mcp/serve#optional-claude-push)
- <a id="important-behavior" />[Important behavior](/cli/mcp/serve#important-behavior)
- <a id="choose-a-client-mode" />[Choose a client mode](/cli/mcp/serve#choose-a-client-mode)
- <a id="generic-mcp-clients" />[Generic MCP clients](/cli/mcp/serve#generic-mcp-clients)
- <a id="claude-code" />[Claude Code](/cli/mcp/serve#claude-code)
- <a id="what-serve-exposes" />[What serve exposes](/cli/mcp/serve#what-serve-exposes)
- <a id="usage" />[Usage](/cli/mcp/serve#usage)
- <a id="local-gateway" />[Local Gateway](/cli/mcp/serve#local-gateway)
- <a id="remote-gateway-token" />[Remote Gateway (token)](/cli/mcp/serve#remote-gateway-token)
- <a id="remote-gateway-password" />[Remote Gateway (password)](/cli/mcp/serve#remote-gateway-password)
- <a id="verbose-%2F-claude-off" />[Verbose / Claude off](/cli/mcp/serve#verbose-%2F-claude-off)
- <a id="bridge-tools" />[Bridge tools](/cli/mcp/serve#bridge-tools)
- <a id="conversations-list" />[conversations_list](/cli/mcp/serve#conversations-list)
- <a id="conversation-get" />[conversation_get](/cli/mcp/serve#conversation-get)
- <a id="messages-read" />[messages_read](/cli/mcp/serve#messages-read)
- <a id="attachments-fetch" />[attachments_fetch](/cli/mcp/serve#attachments-fetch)
- <a id="events-poll" />[events_poll](/cli/mcp/serve#events-poll)
- <a id="events-wait" />[events_wait](/cli/mcp/serve#events-wait)
- <a id="messages-send" />[messages_send](/cli/mcp/serve#messages-send)
- <a id="permissions-list-open" />[permissions_list_open](/cli/mcp/serve#permissions-list-open)
- <a id="permissions-respond" />[permissions_respond](/cli/mcp/serve#permissions-respond)
- <a id="event-model" />[Event model](/cli/mcp/serve#event-model)
- <a id="claude-channel-notifications" />[Claude channel notifications](/cli/mcp/serve#claude-channel-notifications)
- <a id="off" />[off](/cli/mcp/serve#off)
- <a id="on" />[on](/cli/mcp/serve#on)
- <a id="auto-default" />[auto (default)](/cli/mcp/serve#auto-default)
- <a id="mcp-client-config" />[MCP client config](/cli/mcp/serve#mcp-client-config)
- <a id="options" />[Options](/cli/mcp/serve#options)
- <a id="param-url" />[--url](/cli/mcp/serve#param-url)
- <a id="param-token" />[--token](/cli/mcp/serve#param-token)
- <a id="param-token-file" />[--token-file](/cli/mcp/serve#param-token-file)
- <a id="param-password" />[--password](/cli/mcp/serve#param-password)
- <a id="param-password-file" />[--password-file](/cli/mcp/serve#param-password-file)
- <a id="param-claude-channel-mode" />[--claude-channel-mode](/cli/mcp/serve#param-claude-channel-mode)
- <a id="param-v-verbose" />[-v, --verbose](/cli/mcp/serve#param-v-verbose)
- <a id="security-and-trust-boundary" />[Security and trust boundary](/cli/mcp/serve#security-and-trust-boundary)
- <a id="testing" />[Testing](/cli/mcp/serve#testing)
- <a id="troubleshooting" />[Troubleshooting](/cli/mcp/serve#troubleshooting)
- <a id="no-conversations-returned" />[No conversations returned](/cli/mcp/serve#no-conversations-returned)
- <a id="events-poll-or-events-wait-misses-older-messages" />[events_poll or events_wait misses older messages](/cli/mcp/serve#events-poll-or-events-wait-misses-older-messages)
- <a id="claude-notifications-do-not-show-up" />[Claude notifications do not show up](/cli/mcp/serve#claude-notifications-do-not-show-up)
- <a id="approvals-are-missing" />[Approvals are missing](/cli/mcp/serve#approvals-are-missing)
- <a id="openclaw-as-an-mcp-client-registry" />[OpenClaw as an MCP client registry](/cli/mcp/registry#openclaw-as-an-mcp-client-registry)
- <a id="important-behavior-1" />[Important behavior](/cli/mcp/registry#important-behavior)
- <a id="codex-tool-approvals" />[Codex tool approvals](/cli/mcp/registry#codex-tool-approvals)
- <a id="saved-mcp-server-definitions" />[Saved MCP server definitions](/cli/mcp/registry#saved-mcp-server-definitions)
- <a id="common-server-recipes" />[Common server recipes](/cli/mcp/registry#common-server-recipes)
- <a id="filesystem" />[Filesystem](/cli/mcp/registry#filesystem)
- <a id="memory" />[Memory](/cli/mcp/registry#memory)
- <a id="local-script" />[Local script](/cli/mcp/registry#local-script)
- <a id="remote-http" />[Remote HTTP](/cli/mcp/registry#remote-http)
- <a id="desktop%2Fcua" />[Desktop/CUA](/cli/mcp/registry#desktop%2Fcua)
- <a id="json-output-shapes" />[JSON output shapes](/cli/mcp/json-output#json-output-shapes)
- <a id="status-json" />[status --json](/cli/mcp/json-output#status-json)
- <a id="doctor-json" />[doctor --json](/cli/mcp/json-output#doctor-json)
- <a id="probe-json" />[probe --json](/cli/mcp/json-output#probe-json)
- <a id="stdio-transport" />[Stdio transport](/cli/mcp/transports#stdio-transport)
- <a id="sse-%2F-http-transport" />[SSE / HTTP transport](/cli/mcp/transports#sse-%2F-http-transport)
- <a id="sse-/-http-transport" />[SSE / HTTP transport](/cli/mcp/transports#sse-/-http-transport)
- <a id="oauth-workflow" />[OAuth workflow](/cli/mcp/transports#oauth-workflow)
- <a id="save-the-server" />[Save the server](/cli/mcp/transports#save-the-server)
- <a id="start-login" />[Start login](/cli/mcp/transports#start-login)
- <a id="use-the-manual-fallback-when-needed" />[Use the manual fallback when needed](/cli/mcp/transports#use-the-manual-fallback-when-needed)
- <a id="check-authorization" />[Check authorization](/cli/mcp/transports#check-authorization)
- <a id="clear-credentials" />[Clear credentials](/cli/mcp/transports#clear-credentials)
- <a id="streamable-http-transport" />[Streamable HTTP transport](/cli/mcp/transports#streamable-http-transport)
- <a id="control-ui" />[Control UI](/cli/mcp/control-ui#control-ui)
- <a id="mcp-apps" />[MCP Apps](/cli/mcp/apps#mcp-apps)
- <a id="current-limits" />[Current limits](/cli/mcp/serve#current-limits)

## Related

- [Connect MCP servers](/tools/mcp)
- [CLI reference](/cli)
- [Plugins](/cli/plugins)
