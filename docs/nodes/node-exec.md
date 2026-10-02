---
summary: "Allowlist node commands, point exec at a node, and invoke commands directly"
read_when:
  - Routing exec tool calls to a paired node
  - Allowlisting node commands or binding exec to one node
  - Invoking a node command over raw RPC
title: "Run commands on a node"
sidebarTitle: "Node exec"
---

## Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host in
`~/.openclaw/state/openclaw.sqlite#exec_approvals_config`.

## Point exec at the node

Configure defaults (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.mode allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Or per session:

```text
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the node allowlist/approvals).

`host=auto` will not implicitly choose the node on its own. An explicit per-call `host=node` request is allowed from `auto` only when no sandbox runtime is active; while a sandbox runtime is active, `auto` rejects it. To run on a node from a sandboxed session, or to make node exec the session default, set `tools.exec.host=node` or `/exec host=node ...` explicitly.

Related:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.info --params '{}'
```

`nodes invoke` blocks `system.run` and `system.run.prepare`; those commands only run through the `exec` tool with `host=node` (see above). Higher-level helpers exist for the common "give the agent a MEDIA attachment" workflows (camera, screen, location: see [Node device commands](/nodes/device-commands)).

Long-running streaming node commands use additive `node.invoke.progress`
events. Each event carries the invoke ID, a zero-based sequence number, and a
bounded UTF-8 text chunk; the Gateway orders chunks before delivering them to
the caller. The existing `node.invoke.result` remains the single terminal
response. Streaming callers can set an inactivity deadline that starts with the
first progress event and resets after later progress while retaining the
invoke's separate hard timeout during approval and execution. Result, hard
timeout, inactivity timeout, and node disconnect all discard pending stream
state. Caller cancellation emits `node.invoke.cancel` with the published
`NodeInvokeCancelEvent` payload (`invokeId` and `nodeId`); the node host then
terminates the matching process tree. Existing request/response commands are unchanged.

## Codex sessions on a node

A session host using the Codex runtime also needs the `codex` plugin installed and
enabled in the **node host's** OpenClaw configuration. `--session-host` alone does not
install or enable this plugin. On the node, install it if missing, then enable it:

```bash
openclaw plugins install @openclaw/codex
openclaw plugins enable codex
openclaw node restart
```

If you run `openclaw node run` in the foreground, stop and restart that process
instead. Approve the node's updated command surface after it reconnects. The Gateway
must also allow `codex.exec-server.stdio.v1` in `gateway.nodes.commands.allow` without
a matching deny entry. Codex execution keeps its separate placement approval; enabling
the plugin does not grant that approval.

`environments.list` with `runtimeId: "codex"` reports a `requiredNodeCommand` state and
an actionable `message` when the node does not advertise the command, awaits pairing
approval, or is blocked by Gateway policy. A missing node advertisement requires
installing and enabling the plugin on the node; changing the Gateway allowlist alone
cannot add it. See [Install plugins](/cli/plugins/install) for installation sources.

See [Codex paired-device placement](/plugins/codex-harness/placement#run-codex-on-a-paired-device).

## Exec node binding

With no node target set, `exec host=node` selects the sole paired, connected node that supports `system.run`. Other paired devices do not make the selection ambiguous. If multiple executable nodes are connected, choose a target per call or bind exec to a specific node; the active Canvas target does not select the exec host. A bound or explicit target that is offline or cannot execute commands is rejected rather than redirected to another node.

A binding sets the default node for `exec host=node` and can be overridden per agent.

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.entries
openclaw config set 'agents.entries.main.tools.exec.node' "node-id-or-name"
```

Unset the binding to use the sole eligible node, or choose a target per call when multiple eligible nodes are connected:

```bash
openclaw config unset tools.exec.node
openclaw config unset 'agents.entries.main.tools.exec.node'
```
