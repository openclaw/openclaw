---
summary: "Platform default allowlists, dangerous-command opt-ins, and the gateway.nodes configuration"
read_when:
  - Checking which commands a platform allows by default
  - Opting into dangerous or privacy-heavy node commands
  - Configuring gateway.nodes and tools.exec
title: "Node command policy"
sidebarTitle: "Command policy"
---

## Command policy

Node commands must pass two gates before they can be invoked:

1. The node must declare the command in its authenticated connect metadata (`connect.commands`).
2. The gateway's platform-and-approval-derived allowlist must include the declared command.

Default allowlists by platform (before plugin defaults and `commands.allow`/`commands.deny` overrides):

| Platform | Commands allowed by default                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | `camera.list`, `location.get`, `device.info`, `device.status`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`                                                                                                                                                              |
| watchOS  | `device.info`, `device.status`, `system.notify`                                                                                                                                                                                                                                                                                                             |
| Android  | `camera.list`, `location.get`, `notifications.list`, `notifications.actions`, `system.notify`, `device.info`, `device.status`, `device.permissions`, `device.health`, `device.apps`, `contacts.search`, `calendar.events`, `callLog.search`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `mobile.ui.observe`, `mobile.ui.act` |
| macOS    | `camera.list`, `camera.ptz.status`, `location.get`, `device.info`, `device.status`, `device.apps`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`, `computer.act`                                                                                                          |
| Windows  | `camera.list`, `location.get`, `device.info`, `device.status`, `system.notify`, `computer.act`                                                                                                                                                                                                                                                              |
| Linux    | `system.notify`, `computer.act` (node host commands like `system.run` are approval-gated, see below)                                                                                                                                                                                                                                                        |

These rows describe the Gateway policy ceiling, not the commands implemented by every node app. A command is usable only when the connected node also declares it. In particular, Android advertises mobile UI commands only while Accessibility Control is enabled, and desktop nodes advertise `computer.act` only while their local Computer Control fulfiller is enabled. The current macOS app does not declare the device and personal-data families listed in the macOS policy row.

Plugin-owned defaults extend the platform table only for the plugin's supported
surface:

| Plugin | Platform | Commands allowed by default                        |
| ------ | -------- | -------------------------------------------------- |
| Canvas | macOS    | `canvas.present`, `canvas.hide`, `canvas.navigate` |

The Canvas commands present hosted widget documents in the macOS app's native
panel. iOS, Android, Windows, Linux, and unknown platforms do not receive Canvas
plugin defaults.

`talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` are allowed by default for any node that advertises the `talk` capability or declares `talk.*` commands, independent of platform label.

Desktop host commands (`system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `browser.proxy.upload.v1`, `mcp.tools.call.v1`, and `screen.snapshot` on macOS/Windows/Linux) are not part of the static platform-default table above. They become available once the operator approves a pairing request that declares them, after which the node's approved command set carries them forward on reconnect.

Dangerous or privacy-heavy commands require a one-time persistent opt-in with `gateway.nodes.commands.allow`, even if a node declares them: `camera.snap`, `camera.clip`, `camera.ptz.control`, `desktop.stream`, `screen.record`, `contacts.add`, `calendar.add`, `reminders.add`, `health.summary`, `sms.send`, `sms.search`. `gateway.nodes.commands.deny` always wins over defaults and extra allowlist entries. See [Paired node desktops](/gateway/config-browser-ui-desktop#paired-node-desktops), [HealthKit summaries](/platforms/ios-healthkit), and [Computer use](/nodes/computer-use) for the local enablement, pairing, capability, and tool-policy gates around desktop access.

Plugin-owned node commands can add a Gateway node-invoke policy. That policy runs after the allowlist check and before forwarding to the node, so raw `node.invoke`, CLI helpers, and dedicated agent tools share the same plugin permission boundary. Dangerous plugin node commands still require explicit `gateway.nodes.commands.allow` opt-in.

After a node changes its declared command list, reconnect it, inspect `openclaw nodes pending`, and approve the widened surface with `openclaw nodes approve <requestId>` so the Gateway stores the updated command snapshot.

## Config (`openclaw.json`)

Node-related settings live under `gateway.nodes` and `tools.exec`:

```json5
{
  gateway: {
    nodes: {
      // Auto-approve first-time node pairing from trusted networks (CIDR list).
      // Disabled when unset. Only applies to first-time role:node requests
      // with no requested scopes; does not auto-approve upgrades. This
      // approves the device only: the node's command/capability surface still
      // needs `openclaw nodes approve <requestId>` (see `openclaw nodes
      // pending`), because device pairing alone must not grant commands.
      // Silent same-host pairing behaves the same way. SSH-verified pairing
      // and node-profile setup codes approve the initial surface, since both
      // record explicit machine-ownership or admin consent.
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
        // SSH-verified auto-approval (default: enabled). Approves first-time
        // node pairing on an exact device-key match read back over SSH.
        sshVerify: true,
      },
      // Trust agent-visible plugin tools published by paired nodes (default: true).
      pluginTools: {
        enabled: true,
      },
      // Persistently enable dangerous/privacy-heavy node commands.
      commands: {
        allow: ["camera.snap", "desktop.stream", "screen.record"],
        // Block exact command names even if defaults or commands.allow include them.
        deny: ["camera.clip"],
      },
    },
  },
  tools: {
    exec: {
      // Default exec host: "node" routes all exec calls to a paired node.
      host: "node",
      // Security mode for node exec: allow only approved/allowlisted commands.
      security: "allowlist",
      // Pin exec to a specific node (id or name). Omit to allow any node.
      node: "build-node",
    },
  },
}
```

Use exact node command names. `commands.deny` removes a command even when a platform default or `commands.allow` entry would otherwise allow it. Paired nodes may publish agent-visible plugin tool descriptors by default, but each descriptor's command must still be in the node's approved command surface. Set `gateway.nodes.pluginTools.enabled: false` to ignore all such descriptors. See [Gateway configuration reference](/gateway/config-gateway#gateway) for gateway node pairing and command-policy field details.

Per-agent exec node override:

```json5
{
  agents: {
    entries: {
      main: {
        default: true,
        tools: { exec: { node: "build-node" } },
      },
    },
  },
}
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`, `location`) with boolean values (`true` = granted).
