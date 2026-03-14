---
summary: "CLI reference for `openclaw tunnel` (SSH port-forward tunnels)"
read_when:
  - You run your gateway on a remote machine and connect over SSH
  - You want a managed alternative to manual SSH tunneling (autossh, shell aliases)
  - You need to check if a port-forward tunnel is active
title: "tunnel"
---

# `openclaw tunnel`

Manage persistent SSH port-forward tunnels to a remote gateway.

If your gateway runs on a remote server, `openclaw tunnel` replaces manual SSH alias workflows
(`autossh -M 0 -f -N myserver`, `pkill -f autossh`, `lsof -i | grep 18789`) with a tracked,
first-class CLI command.

The tunnel runs in the background using native SSH with keepalive flags
(`ServerAliveInterval`, `ExitOnForwardFailure`, `BatchMode`) — no `autossh` dependency required.
State is persisted to `~/.openclaw/tunnel.pid.json` so `down` and `status` work across shells.

## Commands

| Command | Description |
|---|---|
| `tunnel up <target>` | Start a background SSH tunnel to a remote gateway |
| `tunnel down` | Stop the running SSH tunnel |
| `tunnel status` | Show tunnel status and port binding |

## `tunnel up`

```bash
openclaw tunnel up <target> [--port <port>] [--identity <path>]
```

Starts a detached SSH port-forward from `localhost:<port>` to `<target>:<port>`.

**Arguments**

| Argument | Description |
|---|---|
| `<target>` | SSH target: `user@host` or `user@host:sshport` |

**Options**

| Option | Default | Description |
|---|---|---|
| `--port <port>` | `18789` | Gateway port to forward (local and remote) |
| `--identity <path>` | — | SSH identity file (optional, e.g. `~/.ssh/id_ed25519`) |

**Examples**

```bash
# Basic usage — default port 18789
openclaw tunnel up user@gateway-host

# Non-standard SSH port
openclaw tunnel up user@gateway-host:2222

# Custom gateway port + explicit identity
openclaw tunnel up user@gateway-host --port 19001 --identity ~/.ssh/id_ed25519
```

## `tunnel down`

```bash
openclaw tunnel down
```

Stops the running tunnel and removes the PID file. If no tunnel is running (or the process
already exited), prints a gentle message and exits cleanly.

## `tunnel status`

```bash
openclaw tunnel status
```

Shows the current tunnel state: target, local port, PID, start time, and whether the process
is alive and the port is bound. Automatically cleans up stale PID files if the process has exited.

## Prerequisites

- SSH key auth must be configured for the remote host — the tunnel runs in `BatchMode` (no
  interactive password prompts).
- The remote host must already be in `~/.ssh/known_hosts`. Run `ssh user@host` manually
  once to accept the host key before using `tunnel up`.
- Port forwarding must be allowed on the remote (`AllowTcpForwarding yes` in `sshd_config`,
  which is the default on most systems).
