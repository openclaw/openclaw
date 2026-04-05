---
title: Sandbox CLI
summary: "Manage sandbox runtimes and inspect effective sandbox policy"
read_when: "You are managing sandbox runtimes or debugging sandbox/tool-policy behavior."
status: active
---

# Sandbox CLI

Manage sandbox runtimes for isolated agent execution.

## Overview

Mullusi can run agents in isolated sandbox runtimes for security. The `sandbox` commands help you inspect and recreate those runtimes after updates or configuration changes.

Today that usually means:

- Docker sandbox containers
- SSH sandbox runtimes when `agents.defaults.sandbox.backend = "ssh"`
- OpenShell sandbox runtimes when `agents.defaults.sandbox.backend = "openshell"`

For `ssh` and OpenShell `remote`, recreate matters more than with Docker:

- the remote workspace is canonical after the initial seed
- `mullusi sandbox recreate` deletes that canonical remote workspace for the selected scope
- next use seeds it again from the current local workspace

## Commands

### `mullusi sandbox explain`

Inspect the **effective** sandbox mode/scope/workspace access, sandbox tool policy, and elevated gates (with fix-it config key paths).

```bash
mullusi sandbox explain
mullusi sandbox explain --session agent:main:main
mullusi sandbox explain --agent work
mullusi sandbox explain --json
```

### `mullusi sandbox list`

List all sandbox runtimes with their status and configuration.

```bash
mullusi sandbox list
mullusi sandbox list --browser  # List only browser containers
mullusi sandbox list --json     # JSON output
```

**Output includes:**

- Runtime name and status
- Backend (`docker`, `openshell`, etc.)
- Config label and whether it matches current config
- Age (time since creation)
- Idle time (time since last use)
- Associated session/agent

### `mullusi sandbox recreate`

Remove sandbox runtimes to force recreation with updated config.

```bash
mullusi sandbox recreate --all                # Recreate all containers
mullusi sandbox recreate --session main       # Specific session
mullusi sandbox recreate --agent mybot        # Specific agent
mullusi sandbox recreate --browser            # Only browser containers
mullusi sandbox recreate --all --force        # Skip confirmation
```

**Options:**

- `--all`: Recreate all sandbox containers
- `--session <key>`: Recreate container for specific session
- `--agent <id>`: Recreate containers for specific agent
- `--browser`: Only recreate browser containers
- `--force`: Skip confirmation prompt

**Important:** Runtimes are automatically recreated when the agent is next used.

## Use Cases

### After updating a Docker image

```bash
# Pull new image
docker pull mullusi-sandbox:latest
docker tag mullusi-sandbox:latest mullusi-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
mullusi sandbox recreate --all
```

### After changing sandbox configuration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
mullusi sandbox recreate --all
```

### After changing SSH target or SSH auth material

```bash
# Edit config:
# - agents.defaults.sandbox.backend
# - agents.defaults.sandbox.ssh.target
# - agents.defaults.sandbox.ssh.workspaceRoot
# - agents.defaults.sandbox.ssh.identityFile / certificateFile / knownHostsFile
# - agents.defaults.sandbox.ssh.identityData / certificateData / knownHostsData

mullusi sandbox recreate --all
```

For the core `ssh` backend, recreate deletes the per-scope remote workspace root
on the SSH target. The next run seeds it again from the local workspace.

### After changing OpenShell source, policy, or mode

```bash
# Edit config:
# - agents.defaults.sandbox.backend
# - plugins.entries.openshell.config.from
# - plugins.entries.openshell.config.mode
# - plugins.entries.openshell.config.policy

mullusi sandbox recreate --all
```

For OpenShell `remote` mode, recreate deletes the canonical remote workspace
for that scope. The next run seeds it again from the local workspace.

### After changing setupCommand

```bash
mullusi sandbox recreate --all
# or just one agent:
mullusi sandbox recreate --agent family
```

### For a specific agent only

```bash
# Update only one agent's containers
mullusi sandbox recreate --agent alfred
```

## Why is this needed?

**Problem:** When you update sandbox configuration:

- Existing runtimes continue running with old settings
- Runtimes are only pruned after 24h of inactivity
- Regularly-used agents keep old runtimes alive indefinitely

**Solution:** Use `mullusi sandbox recreate` to force removal of old runtimes. They'll be recreated automatically with current settings when next needed.

Tip: prefer `mullusi sandbox recreate` over manual backend-specific cleanup.
It uses the Gateway’s runtime registry and avoids mismatches when scope/session keys change.

## Configuration

Sandbox settings live in `~/.mullusi/mullusi.json` under `agents.defaults.sandbox` (per-agent overrides go in `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "backend": "docker", // docker, ssh, openshell
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "mullusi-sandbox:bookworm-slim",
          "containerPrefix": "mullusi-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## See Also

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - Check sandbox setup
