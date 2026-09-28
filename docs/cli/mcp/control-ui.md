---
summary: "Edit and inspect MCP servers from the browser Control UI settings page"
title: "MCP in the Control UI"
read_when:
  - Editing MCP config from a browser instead of the CLI
  - Looking for the Control UI MCP inventory or enablement toggles
---

The Control UI has a dedicated MCP settings page for operator edits and quick
inventory.

## Control UI

The browser Control UI includes a dedicated MCP settings page at `/settings/mcp`; the previous `/mcp` path remains an alias. The page shows configured server counts, enabled/OAuth/filter summaries, per-server transport rows, enable/disable controls, common CLI commands, and a scoped editor for the `mcp` config section.

For a shorter setup walkthrough covering Settings, the composer path (**+** → **Connectors** → **Add MCP server…**) and its **This session** / **Everywhere** scopes, CLI, and direct config, see [Connect MCP servers](/tools/mcp).

Use the page for operator edits and quick inventory. Use `openclaw mcp doctor --probe` or `openclaw mcp probe` when you need live server proof.

Installed plugins also show a sign-in alert on their detail page when a matching
HTTP MCP server is configured with `auth: "oauth"` and its shared operator account
has no saved credentials or requires authorization. **Connect** opens the existing
OAuth sign-in flow; the page refreshes its saved authorization status when sign-in
finishes. An administrator connection is required.

The server name and URL must match the plugin's active MCP declaration. This
alert does not probe service health or discover OAuth for an unconfigured URL.
Local stdio servers, per-requester accounts, and `oauth.authProfileId` connections
keep their existing authentication setup paths.

Operator workflow:

1. Open the Control UI and choose **MCP**.
2. Review the summary cards for total, enabled, OAuth, and filtered servers.
3. Use each server row for transport, auth, filter, timeout, and command hints.
4. Toggle enablement when you want to keep a definition but exclude it from runtime discovery.
5. Edit the scoped `mcp` config section for structural changes such as new servers, headers, TLS, OAuth metadata, or tool filters.
6. Choose **Save** to persist config only, or **Save & Publish** to apply through the Gateway config path.
7. Run `openclaw mcp doctor --probe` when you need live proof that the edited server starts and lists tools.

Notes:

- command snippets quote server names so unusual names remain copyable in a shell
- displayed URL-like values are redacted before rendering when they contain embedded credentials
- the page does not start MCP transports by itself
- active runtimes may need `openclaw mcp reload`, Gateway config publish, or process restart depending on which process owns the MCP clients
