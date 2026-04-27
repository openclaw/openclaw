---
summary: "Set up Codex Computer Use for Codex-mode OpenClaw agents"
title: "Codex Computer Use"
read_when:
  - You want Codex-mode OpenClaw agents to use Codex Computer Use
  - You are configuring computerUse for the bundled Codex plugin
  - You are troubleshooting /codex computer-use status or install
---

Computer Use is a Codex-native MCP plugin for local desktop control. OpenClaw
does not vendor the desktop app, execute desktop actions itself, or bypass
Codex permissions. The bundled `codex` plugin only prepares Codex app-server:
it enables Codex plugin support, finds or installs the configured Codex
Computer Use plugin, checks that the `computer-use` MCP server is available, and
then lets Codex own the native MCP tool calls during Codex-mode turns.

Use this page when OpenClaw is already using the native Codex harness. For the
runtime setup itself, see [Codex harness](/plugins/codex-harness).

## Quick setup

Set `plugins.entries.codex.config.computerUse` when Codex-mode turns must have
Computer Use available before a thread starts:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          computerUse: {
            autoInstall: true,
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      embeddedHarness: {
        runtime: "codex",
      },
    },
  },
}
```

With this config, OpenClaw checks Codex app-server before each Codex-mode turn.
If Computer Use is missing but Codex app-server has already discovered an
installable marketplace, OpenClaw asks Codex app-server to install or re-enable
the plugin and reload MCP servers. If setup still cannot make the MCP server
available, the turn fails before the thread starts.

## Commands

Use the `/codex computer-use` commands from any chat surface where the `codex`
plugin command surface is available:

```text
/codex computer-use status
/codex computer-use install
/codex computer-use install --source <marketplace-source>
/codex computer-use install --marketplace-path <path>
/codex computer-use install --marketplace <name>
```

`status` is read-only. It does not add marketplace sources, install plugins, or
enable Codex plugin support.

`install` enables Codex app-server plugin support, optionally adds a configured
marketplace source, installs or re-enables the configured plugin through Codex
app-server, reloads MCP servers, and verifies that the MCP server exposes tools.

## Marketplace choices

OpenClaw uses the same app-server API that Codex itself exposes. The
marketplace fields choose where Codex should find `computer-use`.

| Field                | Use when                                                        | Install support                                          |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| No marketplace field | You want Codex app-server to use marketplaces it already knows. | Yes, when app-server returns a local marketplace.        |
| `marketplaceSource`  | You have a Codex marketplace source app-server can add.         | Yes, for explicit `/codex computer-use install`.         |
| `marketplacePath`    | You already know the local marketplace file path on the host.   | Yes, for explicit install and turn-start auto-install.   |
| `marketplaceName`    | You want to select one already registered marketplace by name.  | Yes only when the selected marketplace has a local path. |

Fresh Codex homes may need a short moment to seed their official marketplaces.
During install, OpenClaw polls `plugin/list` for up to
`marketplaceDiscoveryTimeoutMs` milliseconds. The default is 60 seconds.

If multiple known marketplaces contain Computer Use, OpenClaw prefers
`openai-bundled`, then `openai-curated`, then `local`. Unknown ambiguous matches
fail closed and ask you to set `marketplaceName` or `marketplacePath`.

## Remote catalog limit

Codex app-server can list and read remote-only catalog entries, but it does not
currently support remote `plugin/install`. That means `marketplaceName` can
select a remote-only marketplace for status checks, but installs and re-enables
still need a local marketplace via `marketplaceSource` or `marketplacePath`.

If status says the plugin is available in a remote Codex marketplace but remote
install is unsupported, run install with a local source or path:

```text
/codex computer-use install --source <marketplace-source>
/codex computer-use install --marketplace-path <path>
```

## Configuration reference

| Field                           | Default        | Meaning                                                                        |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `enabled`                       | inferred       | Require Computer Use. Defaults to true when another Computer Use field is set. |
| `autoInstall`                   | false          | Install or re-enable from already discovered marketplaces at turn start.       |
| `marketplaceDiscoveryTimeoutMs` | 60000          | How long install waits for Codex app-server marketplace discovery.             |
| `marketplaceSource`             | unset          | Source string passed to Codex app-server `marketplace/add`.                    |
| `marketplacePath`               | unset          | Local Codex marketplace file path containing the plugin.                       |
| `marketplaceName`               | unset          | Registered Codex marketplace name to select.                                   |
| `pluginName`                    | `computer-use` | Codex marketplace plugin name.                                                 |
| `mcpServerName`                 | `computer-use` | MCP server name exposed by the installed plugin.                               |

Turn-start auto-install intentionally refuses configured `marketplaceSource`
values. Adding a new source is an explicit setup operation, so use
`/codex computer-use install --source <marketplace-source>` once, then let
`autoInstall` handle future re-enables from discovered local marketplaces.

## What OpenClaw checks

OpenClaw reports a stable setup reason internally and formats the user-facing
status for chat:

| Reason                       | Meaning                                                | Next step                                     |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `disabled`                   | `computerUse.enabled` resolved to false.               | Set `enabled` or another Computer Use field.  |
| `marketplace_missing`        | No matching marketplace was available.                 | Configure source, path, or marketplace name.  |
| `plugin_not_installed`       | Marketplace exists, but the plugin is not installed.   | Run install or enable `autoInstall`.          |
| `plugin_disabled`            | Plugin is installed but disabled in Codex config.      | Run install to re-enable it.                  |
| `remote_install_unsupported` | Selected marketplace is remote-only.                   | Use `marketplaceSource` or `marketplacePath`. |
| `mcp_missing`                | Plugin is enabled, but the MCP server is unavailable.  | Check Codex Computer Use and OS permissions.  |
| `ready`                      | Plugin and MCP tools are available.                    | Start the Codex-mode turn.                    |
| `check_failed`               | A Codex app-server request failed during status check. | Check app-server connectivity and logs.       |
| `auto_install_blocked`       | Turn-start setup would need to add a new source.       | Run explicit install first.                   |

The chat output includes the plugin state, MCP server state, marketplace, tools
when available, and the specific message for the failing setup step.

## macOS permissions

Computer Use is macOS-specific. The Codex-owned MCP server may need local OS
permissions before it can inspect or control apps. If OpenClaw says Computer Use
is installed but the MCP server is unavailable, verify the Codex-side Computer
Use setup first:

- Codex app-server is running on the same host where desktop control should
  happen.
- The Computer Use plugin is enabled in Codex config.
- The `computer-use` MCP server appears in Codex app-server MCP status.
- macOS has granted the required permissions for the desktop-control app.
- The current host session can access the desktop being controlled.

OpenClaw intentionally fails closed when `computerUse.enabled` is true. A
Codex-mode turn should not silently proceed without the native desktop tools
that the config required.

## Troubleshooting

**Status says not installed.** Run `/codex computer-use install`. If the
marketplace is not discovered, pass `--source` or `--marketplace-path`.

**Status says installed but disabled.** Run `/codex computer-use install` again.
Codex app-server install writes the plugin config back to enabled.

**Status says remote install is unsupported.** Use a local marketplace source or
path. Remote-only catalog entries can be inspected but not installed through the
current app-server API.

**Status says the MCP server is unavailable.** Re-run install once so MCP
servers reload. If it remains unavailable, fix the Codex Computer Use app,
Codex app-server MCP status, or macOS permissions.

**Turn-start auto-install refuses a source.** This is intentional. Add the
source with explicit `/codex computer-use install --source <marketplace-source>`
first, then future turn-start auto-install can use the discovered local
marketplace.
