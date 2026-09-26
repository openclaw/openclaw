---
summary: "Connect MCP servers to OpenClaw from the Control UI, CLI, or config"
title: "Connect MCP servers"
read_when:
  - Adding an MCP server for OpenClaw agents
  - Choosing between Settings and `openclaw mcp`
  - Troubleshooting MCP transport, OAuth, or tool discovery
---

The Model Context Protocol (MCP) is how an agent borrows tools from another program: an MCP server exposes tools, resources, and prompts, and OpenClaw connects to it and makes those tools available to your agents. Server definitions live under `mcp.servers` in config, and the tools they expose go through the same tool-profile and tool-policy controls as everything else — connecting a server does not bypass your policy.

<Note>
This guide is about connecting third-party MCP servers **to OpenClaw**. For the reverse — exposing OpenClaw channel conversations to another MCP client — use [`openclaw mcp serve`](/cli/mcp#openclaw-as-an-mcp-server).
</Note>

## Add a server from Settings

1. Open the Control UI and go to **Settings → MCP**.
2. Under **Configured servers**, select **Add server**.
3. Give it a unique name and pick a transport: **Streamable HTTP**, **SSE**, or **Stdio**.
4. For the HTTP transports, enter the server's `http://` or `https://` URL. For stdio, enter the command followed by its arguments.
5. Select **Add server**.

That writes the new `mcp.servers` entry through the Gateway. For anything beyond the basics — headers, environment values, OAuth metadata, TLS settings, timeouts, parallel-tool-call hints, tool filters — use the scoped config editor further down the page. The server rows also let you enable, disable, or remove a definition.

Once the server is saved, verify it actually answers:

```bash
openclaw mcp doctor <name> --probe
```

Saving a definition proves nothing about reachability — the probe does. With Gateway hot reload enabled, changed or removed servers retire immediately and the next turn's discovery uses the new definition. Unchanged servers keep their connections and cached tools, including for runs already in progress. Requester sign-in tools refresh on the next message after runtime replacement.

When OpenClaw's built-in MCP client cannot start a server, new runtimes skip it during an exponential backoff: 30 seconds, doubling up to 10 minutes. The runtime that encountered the first failure can retry once on its normal five-second catalog schedule, using a fresh connection after retiring the failed one. If that recovery attempt also fails, the same exponential backoff applies to it. Failure state survives ordinary session cleanup and is scoped to the server configuration and requester. The effective tool inventory shows the server as unavailable, with that runtime's next retry time and a reachability check as the next step. Each failed retry logs once; skipped runs do not repeat the warning. A successful connection, config publication, or explicit MCP reload clears the backoff. Reload the process that owns the connection; a CLI reload does not reset a separate Gateway.

## Add a server from the composer

In a Control UI chat, select **+** → **Connectors** → **Add MCP server…**. The dialog uses the same server fields as Settings and requires administrator access.

Choose **This session** for session-only enablement or **Everywhere** for global enablement. Either scope saves a global server definition; session policy is the per-session layer. See [Composer capability menu](/web/control-ui/chat#composer-capability-menu) for the complete scope and tool-access behavior.

From an active conversation, open **+ → Connectors → Tool access** to inspect
or deny individual tools for that session. The view follows the session's
actual runtime owner: built-in OpenClaw sessions read the in-process MCP
catalog, while native agent harnesses can contribute their thread-owned
catalog. Session server and tool denials are enforced by either runtime before
the next turn starts.

## Add a server from the CLI

A local stdio server:

```bash
openclaw mcp add local-tools \
  --command node \
  --arg ./dist/mcp-server.js \
  --cwd /srv/openclaw-tools
openclaw mcp doctor local-tools --probe
```

A remote Streamable HTTP server, exposing only some of its tools:

```bash
openclaw mcp add docs \
  --url https://mcp.example.com/mcp \
  --transport streamable-http \
  --include 'search,read_*'
openclaw mcp doctor docs --probe
```

Useful companions: `openclaw mcp status --verbose` for a config-only summary, `openclaw mcp probe <name>` for live capabilities, and `openclaw mcp login <name>` when an HTTP server uses OAuth. The [MCP CLI reference](/cli/mcp) documents every command, flag, and output shape, plus the separate `mcp serve` bridge.

For ready-made examples, including Screenpipe screen and audio history, see
[Common server recipes](/cli/mcp/registry#common-server-recipes).

## Configure a server directly

The same `docs` server, written straight into config:

```json5
{
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        enabled: true,
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 20000,
        toolFilter: {
          include: ["search", "read_*"],
        },
      },
    },
  },
}
```

An enabled server needs either a command (stdio) or a URL (SSE or Streamable HTTP). The exact server name `__proto__` is reserved; choose a different name. Setting `enabled: false` keeps the definition around without connecting it. Keep credentials out of config literals — store sensitive headers and environment values through the supported secret mechanisms.

## Approvals

Codex MCP tool approvals follow the session permission posture: the default full-permission posture does not prompt, while stricter modes check tools without safety annotations (`workspace` can use automatic review; `guarded` and `read-only` can prompt the operator).

When durable persistence is offered, **Allow Always** saves a per-agent grant
for the exact configured server and tool, even when its arguments change.
This applies to Gateway-hosted Codex runs when OpenClaw can unambiguously match
the approval to a live Gateway-owned tool call; missing or ambiguous matches retain
Codex's native/session behavior. Codex apps, native plugin servers, and
computer-use servers are excluded. Grants survive restarts and apply at the
next thread configuration and hook registration, such as a new session or
restart; the current session uses Codex's remembered decision.

Override a server with `openclaw mcp configure <server> --approval approve|prompt|auto`; an explicit mode takes precedence over the posture-derived default. Stored grants apply only under `auto` or an unspecified server mode; explicit `prompt` keeps asking. Inspect or revoke grants through [MCP tool grants](/tools/exec-approvals#mcp-tool-grants). See [Codex tool approvals](/cli/mcp#codex-tool-approvals) for details and [Native approvals in Slack](/channels/slack/rich-messages#native-approvals-in-slack) for Slack button delivery.

## Troubleshooting

### The server appears in Settings but exposes no tools

Run `openclaw mcp doctor <name> --probe`. Doctor validates the saved definition first, then opens a live connection and reports the tools and other capabilities the server advertises. If it connects but expected tools are missing, check `toolFilter.include` and `toolFilter.exclude`.

### A stdio server does not start

Confirm the `command` resolves in the Gateway process environment and that `cwd` exists. Arguments belong in `args`, and an explicit `transport: "stdio"` requires a non-empty command.

For servers launched by OpenClaw's built-in MCP client, debug logs prefix stderr diagnostics with `bundle-mcp:<name>:`. Unicode characters survive split writes, and shutdown diagnostics are retained. Output without a newline is briefly buffered for up to 250 ms before being logged as progress fragments; this does not wait for the server to stop writing. A diagnostic exceeding the 8 KiB buffer retains its Unicode-safe tail with a `[stderr line truncated]` marker.

### An HTTP server needs authorization

Set `auth: "oauth"` plus any required `oauth` metadata. In **Settings → MCP**, an administrator can select **Sign in** for an enabled HTTP server that uses shared native OAuth credentials. Approve access in the browser, then return to Settings. If the browser blocks the new tab, use the sign-in link in the dialog.

**Authentication saved** means credentials were saved on the Gateway selected when sign-in started. It does not prove the server is reachable or its tools work; run a probe or use the connector next. Changing the selected Gateway or agent closes the dialog. A Gateway restart ends an unfinished browser sign-in, but does not remove saved credentials.

Browser sign-in requires Settings on the Gateway's own loopback address or its published Tailscale address. Older Gateways and unsupported addresses keep the terminal instructions. Servers with an existing auth-profile mapping or per-requester identity use that account's sign-in path instead; Settings does not create a second credential for them.

If **Sign in** is unavailable, or the server's registered client accepts only the CLI callback, run this on the installation that owns the connector:

```bash
openclaw mcp login <name>
```

Follow the printed authorization URL. OpenClaw normally captures the loopback redirect and saves the credentials automatically; use the printed `--code` command when the browser cannot reach the callback listener.

### Changes do not reach an active agent

`openclaw mcp reload` refreshes runtimes owned by the current CLI process. A Gateway or agent running elsewhere needs its own reload, config publish, or restart.

## Related

- [Control UI](/web/control-ui/chat#composer-capability-menu)
- [MCP CLI reference](/cli/mcp)
- [Manage plugins](/plugins/manage-plugins)
- [Tool policies](/tools)
