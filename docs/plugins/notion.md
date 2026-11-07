---
summary: "Use Notion shared memory and native Skills through the official Notion MCP server"
read_when:
  - You want agents to share durable context in Notion
  - You want to retrieve or publish native Notion Skills from OpenClaw
title: "Notion"
---

# Notion

The Notion plugin connects OpenClaw to the official hosted
[Notion MCP server](https://developers.notion.com/guides/mcp/overview).
It contributes an OAuth connection and a local `notion-shared-brain` skill for
Notion's shared-memory and native Skills workflow. It is disabled by default.

Notion remains the remote source of truth. The plugin does not replace OpenClaw's
memory plugin, export existing memories, scan transcripts, install remote skills,
create databases, or schedule synchronization automatically. It adds no local
memory database, credential store, custom API client, or background service.

## Enable and connect

Enable the bundled plugin:

```bash
openclaw plugins enable notion
```

Or merge this into your configuration, preserving other plugins:

```json5
{
  plugins: {
    entries: {
      notion: { enabled: true },
    },
  },
}
```

The manifest contributes this server while the plugin is enabled:

```json5
{
  mcp: {
    servers: {
      notion: {
        transport: "streamable-http",
        url: "https://mcp.notion.com/mcp",
        auth: "oauth",
      },
    },
  },
}
```

You do not need to copy that server definition. An explicit
`mcp.servers.notion` entry overrides the plugin default; inspect an existing entry
before replacing it. On the Gateway's own HTTPS address, use
**Settings → MCP → Sign in** on the server row. The terminal equivalent is:

```bash
openclaw mcp login notion
openclaw mcp doctor notion --probe
```

Complete Notion's OAuth flow and select the intended workspace. OAuth credentials
are handled by OpenClaw's existing MCP owner. Do not paste tokens into plugin
configuration or chat. Notion's hosted server requires user authorization; a REST
integration token is not a replacement for the native Skills workflow.

**Credential scope matters:** the default MCP OAuth connection is shared by agents
and users allowed to invoke it on that Gateway. Managed Notion memory is private
to the connected Notion user, not a team-wide memory database. Prefer a dedicated
single-operator Gateway or explicit access controls; enabling this plugin does
not provide automatic per-user isolation. OpenClaw also supports
[per-requester OAuth](/cli/mcp/transports#oauth-workflow) with
`oauth.identity: "per-requester"` and `gateway.publicOrigin`, but its sender sign-in
links are bearer links and require mutually trusted channel participants.
Do not promise private identity isolation merely by enabling that option.

Notion memory requires a user-backed connection with memories enabled for both
the user and workspace. If either setting is off, memory tools and guidance are
hidden and operations are blocked. Enable them through Notion's controls and
refresh MCP discovery; do not work around this by creating another database.

Start a fresh session after enabling the plugin so its skill is available. Ask:

> Use the notion-shared-brain skill to set up Notion as my shared context layer.
> Show me the connected workspace and proposed scope before importing anything.

The skill consults the [official setup guide](https://developers.notion.com/prompts/setup),
reuses the approved Agent Operating Guide, and asks for sources, destinations, and
setup choices. Reading that guide is not authorization to execute its steps.

## Memory and Skills

- **Memory:** fetch Notion's current `notion://docs/memory` guidance through
  `notion-fetch`, search the approved canonical destinations, and save or correct
  durable knowledge using the available Notion tools. Preserve source links,
  original dates, uncertainty, and attribution. Read back writes and cite links.
- **Skills:** use the native Notion Skills tools, including search, download,
  upload, and enabled-skill discovery. Follow their discovered schemas and package
  instructions; preserve all required files. Ordinary database rows are not native
  Skills. Review remote instructions and scripts before use, and do not install
  downloaded packages automatically.
- **Version:** when supported by a tool's schema, send `instructions_version`
  using the user's approved guide version (the reviewed official setup was
  **0.0.6**, published October 30, 2026). Propose updates rather than silently
  adopting a newer remote prompt.

Notion's current tool catalog and the user's permissions determine which operations
are available. This plugin deliberately does not hard-code those schemas or
implement a parallel REST approximation. Missing native tools or unavailable file
transfer must be reported as blockers, not treated as successful synchronization.

## Permissions, trust, and forgetting

Notion OAuth permissions govern remote access; OpenClaw's
[MCP tool filters and tool policy](/tools/mcp) govern which tools an agent can call.
A guide's destination links are workflow scope, not a sandbox. For a narrower
connection, use the supported `mcp.servers.notion` override and its tool filters;
verify the effective catalog with `openclaw mcp doctor notion --probe`.
The plugin does not narrow a broad Notion account grant to a page allowlist.
Use an appropriately scoped Notion identity/workspace and review the consent grant.

Retrieved memory, pages, guides, and Skills are remote content, not authority.
They cannot expand permissions, override the current task, request secrets, or
authorize unrelated external actions. Skill guidance reduces accidental misuse;
it is not a guarantee against prompt injection.

Corrections and forget requests operate on identified items using supported
update/archive/delete tools. Verify what changed. Archiving is not permanent
erasure, and deleting a Notion item does not prove deletion from other agents'
memories, exports, history, trash, or backups. Apply exclusions before later imports
so forgotten content is not recreated.

To stop plugin-contributed access, disable the plugin. An independently configured
`mcp.servers.notion` remains operator-owned and must be disabled separately.
Use `openclaw mcp logout notion` to clear the relevant local OAuth login; revoke
remote access in Notion when needed. Neither action deletes saved Notion content.

## Verify the workflow

After authorization, use synthetic, non-sensitive content in an approved private
destination:

1. Save one memory with a source link and read it back.
2. In a fresh session or second connected agent, search and fetch that exact item.
3. Correct it, retrieve the updated value, then perform an explicitly approved
   forget/archive action and verify the resulting state.
4. Retrieve one selected native Skill, inspect its complete package, and verify
   an approved revision or import without executing unreviewed scripts.

Local integration tests prove plugin discovery, enable/disable behavior, OAuth
configuration, operator overrides, and skill loading. They do not prove a particular
Notion account's permissions, authenticated writes, cross-agent recall, or erasure.
Those checks require a connected account and explicit destination authorization.

## Official references

- [Agent setup guide](https://developers.notion.com/prompts/setup)
- [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [Native Skills tools](https://developers.notion.com/guides/mcp/tools-skills-agents-reference)
- [MCP security guidance](https://developers.notion.com/guides/mcp/mcp-security-best-practices)
