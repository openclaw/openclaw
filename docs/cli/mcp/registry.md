---
summary: "Manage OpenClaw-saved MCP server definitions with the mcp registry subcommands"
title: "Manage saved MCP servers"
read_when:
  - Saving a third-party MCP server for OpenClaw-managed agent runs
  - Looking up what `list`, `show`, `status`, `doctor`, `probe`, `add`, `set`, `configure`, `tools`, `login`, `logout`, `reload`, or `unset` does
  - Setting the Codex tool approval mode for a saved server
---

This page covers the OpenClaw MCP client-side registry: the subcommands that
read and write `mcp.servers` definitions, their Codex approval behavior, and
ready-made server recipes.

## OpenClaw as an MCP client registry

This is the `openclaw mcp list`, `show`, `status`, `doctor`, `probe`, `add`, `set`,
`configure`, `tools`, `login`, `logout`, `reload`, and `unset` path.

These commands do not expose OpenClaw over MCP. They manage OpenClaw-managed MCP server definitions under `mcp.servers` in OpenClaw config. They do not read mcporter servers from `config/mcporter.json`.

Those saved definitions are for runtimes that OpenClaw launches or configures later, such as embedded OpenClaw and other runtime adapters. OpenClaw stores the definitions centrally so those runtimes do not need to keep their own duplicate MCP server lists.

<AccordionGroup>
  <Accordion title="Important behavior">
    - these commands only read or write OpenClaw config
    - `status`, `list`, `show`, `doctor` without `--probe`, `set`, `configure`, `tools`, `logout`, `reload`, and `unset` do not connect to the target MCP server
    - `login` performs the MCP OAuth network flow for the configured HTTP server and saves the resulting local credentials
    - `status --verbose` prints resolved transport, auth, timeout, filter, and parallel-tool-call hints without connecting
    - `doctor` checks saved definitions for local setup problems such as missing stdio commands, invalid working directories, missing TLS files, disabled servers, literal sensitive header/env values, and incomplete OAuth authorization
    - `doctor --probe` adds the same live connection proof as `probe` after static checks pass
    - `probe` connects to the selected server or all configured servers, lists tools, and reports capabilities/diagnostics
    - `add` builds a definition from flags and probes before saving unless `--no-probe` is set or OAuth authorization is needed first
    - runtime adapters decide which transport shapes they actually support at execution time
    - `enabled: false` keeps a server saved but excludes it from embedded runtime discovery
    - `requestTimeoutMs` and `connectionTimeoutMs` set per-server request and connection timeouts in milliseconds
    - `supportsParallelToolCalls: true` marks servers that adapters can call concurrently
    - HTTP servers can use static headers, OAuth login, TLS verification control, and mTLS certificate/key paths
    - embedded OpenClaw exposes configured MCP tools in normal `coding` and `messaging` tool profiles; `minimal` still hides them, and `tools.deny: ["bundle-mcp"]` disables them explicitly
    - per-server `toolFilter.include` and `toolFilter.exclude` filter discovered MCP tools before they become OpenClaw tools
    - servers that advertise resources or prompts also expose utility tools for listing/reading resources and listing/fetching prompts; those generated utility names (`resources_list`, `resources_read`, `prompts_list`, `prompts_get`) use the same include/exclude filter
    - fetched prompts present their description and role-labeled messages to the agent, including native image blocks for vision-capable models; Code Mode keeps the original prompt JSON shape
    - dynamic MCP tool-list changes invalidate the cached catalog for that session; the next discovery/use refreshes from the server
    - repeated MCP tool request/protocol failures pause that server briefly so one broken server does not consume the whole turn
    - session-scoped MCP runtimes stay alive between turns until session reset/deletion or compaction ID rollover, explicit Stop, a relevant server config change, or Gateway shutdown; owned stdio children terminate during cleanup
    - detached one-shot runs without a surviving runtime session retire their MCP runtimes at run end; a retained transcript does not extend that lifetime
    - `mcp.sessionIdleTtlMs` is an opt-in idle timeout in milliseconds: unset or `0` keeps runtimes alive, and positive finite values enable idle eviction (fractions round down)
    - a Gateway admits at most 256 OpenClaw-managed runtimes with server connections across sessions and requester partitions; sessions without available servers and sign-in-only catalogs do not consume this limit. Reaching the limit rejects new admissions until you stop or reset unused sessions. See [MCP configuration](/gateway/config-extensions#mcp) for details

  </Accordion>
</AccordionGroup>

Runtime adapters may normalize this shared registry into the shape their downstream client expects. For example, embedded OpenClaw consumes OpenClaw `transport` values directly, while Claude Code and Gemini receive CLI-native `type` values such as `http`, `sse`, or `stdio`.

### Codex tool approvals

MCP tool approvals follow the effective Codex session permission posture unless
you explicitly override the server's approval mode. The default full-permission
posture does not prompt, including for tools without MCP safety annotations.
Stricter postures retain approval checks: `workspace` can use automatic review,
while `guarded` and `read-only` can prompt the operator for unannotated tools.
Interactive turns can approve those calls in the Control UI.

For a server you trust, set the mode while adding it:

```bash
openclaw mcp add memory \
  --command npx \
  --arg -y \
  --arg @modelcontextprotocol/server-memory \
  --approval approve
```

For an existing saved server, update only its approval mode:

```bash
openclaw mcp configure memory --approval approve
```

The flag writes `codex.defaultToolsApprovalMode`. An explicit
`openclaw mcp configure <server> --approval approve|prompt|auto` overrides the
posture-derived default for that server: `approve` bypasses per-call approval,
`prompt` asks for every call, and `auto` uses the tool's safety annotations.
Use `approve` only for trusted servers. `mcp probe` and `mcp doctor --probe`
warn when a server uses `auto` and none of its tools has safety annotations;
that warning describes calls under prompting postures.

When offered, **Allow Always** approves the tool, not just the current arguments.
For Gateway-hosted Codex runs on servers configured in `mcp.servers`, OpenClaw
saves a durable, per-agent server/tool grant in the host approvals document
when durable persistence is offered and the approval matches one live Gateway-owned
tool call unambiguously. Missing or ambiguous matches and requests
that permit only session persistence retain Codex's native/session behavior.
Codex apps, native plugin servers, and computer-use servers are excluded.

Stored grants apply under `auto` or an unspecified server mode. Explicit
`prompt` keeps asking, even with a grant; explicit `approve` already bypasses
approval. A new grant is picked up at the next thread configuration and hook
registration, such as a new session or restart. The current session continues
on Codex's remembered decision.

Use `openclaw approvals get --gateway` to inspect grants and
`openclaw approvals set --gateway --file <file>` to revoke them by editing
`agents.<agentId>.mcpTools`. Revocation also takes effect on the next
preparation/registration. Codex can additionally persist its own approval
when the server is saved in native config; revoke that separately if present.
See [MCP tool grants](/tools/exec-approvals#mcp-tool-grants) for the document
shape and export/edit workflow.

For approval delivery through Slack buttons, see
[Native approvals in Slack](/channels/slack/rich-messages#native-approvals-in-slack).

When an operator denies an MCP tool approval, Codex reports only its generic
"user rejected MCP tool call" to the model; the remedy is shown on the operator
card, not to the model.

The optional `codex` block is OpenClaw projection metadata for Codex app-server
threads only; it does not change ACP sessions, generic Codex harness config, or
other runtime adapters. Use non-empty `codex.agents` to project a server only
into specific OpenClaw agent ids. Empty, blank, or invalid agent lists are
rejected by config validation and omitted by the runtime projection path
instead of becoming global. OpenClaw strips the `codex` metadata before handing
the native `mcp_servers` config to Codex.

### Saved MCP server definitions

Commands:

- `openclaw mcp list [--json]`
- `openclaw mcp show [name] [--json]`
- `openclaw mcp status [--verbose] [--json]`
- `openclaw mcp doctor [name] [--probe] [--json]`
- `openclaw mcp probe [name] [--json]`
- `openclaw mcp add <name> [flags]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp configure <name> [flags]`
- `openclaw mcp tools <name> [--include csv] [--exclude csv] [--clear]`
- `openclaw mcp login <name> [--code code]`
- `openclaw mcp logout <name>`
- `openclaw mcp reload`
- `openclaw mcp unset <name>`

Notes:

- `list` sorts server names.
- `show` without a name prints the full configured MCP server object.
- `status` classifies configured transports without connecting. `--verbose` includes resolved launch, timeout, OAuth, filter, and parallel-call details, including when stored OAuth tokens require additional authorization. Credential-bearing stdio arguments are redacted in text and JSON output.
- `doctor` performs static checks without connecting. Add `--probe` when the command should also verify that enabled servers connect.
- `probe` connects and reports tool counts, resources/prompts support, list-change support, and diagnostics.
- `add` accepts stdio flags such as `--command`, `--arg`, `--env`, and `--cwd`, or HTTP flags such as `--url`, `--transport`, `--header`, `--auth oauth`, TLS, timeout, and tool-selection flags. Use `--approval auto|prompt|approve` to set the Codex tool approval mode.
- `set` expects one JSON object value on the command line.
- `configure` updates enablement, tool filters, timeouts, OAuth, TLS, Codex approval mode, and parallel-tool-call hints without replacing the whole server definition. Add `--probe` to verify the updated server before saving.
- `tools` updates per-server tool filters. Include/exclude entries are MCP tool names and simple `*` globs.
- `login` runs the OAuth flow for HTTP servers configured with `auth: "oauth"`. For a loopback redirect, OpenClaw listens for the browser callback and completes login automatically. The printed `--code` command remains the fallback for remote, headless, or unreachable callbacks.
- `logout` clears stored OAuth credentials for the named server without removing the saved server definition.
- `reload` disposes cached in-process MCP runtimes for the current CLI process only. Gateway or agent processes in another process still need their own reload or restart path.
- Use `transport: "streamable-http"` for Streamable HTTP MCP servers. `openclaw mcp set` also normalizes CLI-native `type: "http"` to the same canonical config shape for compatibility.
- `unset` fails if the named server does not exist.

Examples:

```bash
openclaw mcp list
openclaw mcp show context7 --json
openclaw mcp status --verbose
openclaw mcp doctor --probe
openclaw mcp probe context7 --json
openclaw mcp add memory --command npx --arg -y --arg @modelcontextprotocol/server-memory
openclaw mcp set context7 '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp tools context7 --include 'resolve-library-id,get-library-docs'
openclaw mcp set docs '{"url":"https://mcp.example.com","transport":"streamable-http"}'
openclaw mcp configure docs --timeout 20 --connect-timeout 5 --include 'search,read_*'
openclaw mcp configure docs --auth oauth --oauth-scope 'docs.read'
openclaw mcp login docs
openclaw mcp logout docs
openclaw mcp unset context7
```

### Common server recipes

These examples save server definitions only. Run `openclaw mcp doctor --probe` afterward to prove that the server starts and exposes tools.

<Tabs>
  <Tab title="Filesystem">
    ```bash
    openclaw mcp add files \
      --command npx \
      --arg -y \
      --arg @modelcontextprotocol/server-filesystem \
      --arg "$HOME/Documents" \
      --include 'read_file,list_directory,search_files'
    openclaw mcp doctor files --probe
    ```

    Scope filesystem servers to the smallest directory tree that the agent should read or edit.

  </Tab>
  <Tab title="Memory">
    ```bash
    openclaw mcp add memory \
      --command npx \
      --arg -y \
      --arg @modelcontextprotocol/server-memory
    openclaw mcp probe memory --json
    ```

    Use a tool filter if the server exposes write tools that should not be available to normal agents.

  </Tab>
  <Tab title="Local script">
    ```bash
    openclaw mcp add local-tools \
      --command node \
      --arg ./dist/mcp-server.js \
      --cwd /srv/openclaw-tools \
      --env API_BASE=https://internal.example
    openclaw mcp status --verbose
    ```

    `doctor` checks that `cwd` exists and that the command resolves from the configured environment.

  </Tab>
  <Tab title="Remote HTTP">
    ```bash
    openclaw mcp add docs \
      --url https://mcp.example.com/mcp \
      --transport streamable-http \
      --auth oauth \
      --oauth-scope docs.read \
      --timeout 20 \
      --connect-timeout 5 \
      --include 'search,read_*'
    openclaw mcp doctor docs --probe
    ```

    Use OAuth when the remote server supports it. If the server requires static headers, avoid committing literal bearer tokens.

  </Tab>
  <Tab title="Desktop/CUA">
    ```bash
    openclaw mcp set cua-driver '{"command":"cua-driver","args":["mcp"]}'
    openclaw mcp tools cua-driver --include 'list_apps,get_window_state,click,type_text'
    openclaw mcp doctor cua-driver --probe
    ```

    Direct desktop-control servers inherit the permissions of the process they launch. Use narrow tool filters and OS-level permission prompts.

  </Tab>
</Tabs>
