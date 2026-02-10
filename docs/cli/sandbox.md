---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Sandbox CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Manage sandbox containers and inspect effective sandbox policy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "You are managing sandbox containers or debugging sandbox/tool-policy behavior."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sandbox CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage Docker-based sandbox containers for isolated agent execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can run agents in isolated Docker containers for security. The `sandbox` commands help you manage these containers, especially after updates or configuration changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `openclaw sandbox explain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inspect the **effective** sandbox mode/scope/workspace access, sandbox tool policy, and elevated gates (with fix-it config key paths).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --agent work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox explain --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `openclaw sandbox list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List all sandbox containers with their status and configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox list --browser  # List only browser containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox list --json     # JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Output includes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Container name and status (running/stopped)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker image and whether it matches config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Age (time since creation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Idle time (time since last use)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Associated session/agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `openclaw sandbox recreate`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remove sandbox containers to force recreation with updated images/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --all                # Recreate all containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --session main       # Specific session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --agent mybot        # Specific agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --browser            # Only browser containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --all --force        # Skip confirmation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Options:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all`: Recreate all sandbox containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session <key>`: Recreate container for specific session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent <id>`: Recreate containers for specific agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--browser`: Only recreate browser containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`: Skip confirmation prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** Containers are automatically recreated when the agent is next used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use Cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### After updating Docker images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pull new image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker pull openclaw-sandbox:latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update config to use new image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Recreate containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### After changing sandbox configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Recreate to apply new config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### After changing setupCommand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or just one agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --agent family（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For a specific agent only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update only one agent's containers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw sandbox recreate --agent alfred（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why is this needed?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Problem:** When you update sandbox Docker images or configuration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Existing containers continue running with old settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Containers are only pruned after 24h of inactivity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Regularly-used agents keep old containers running indefinitely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Solution:** Use `openclaw sandbox recreate` to force removal of old containers. They'll be recreated automatically with current settings when next needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: prefer `openclaw sandbox recreate` over manual `docker rm`. It uses the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway’s container naming and avoids mismatches when scope/session keys change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sandbox settings live in `~/.openclaw/openclaw.json` under `agents.defaults.sandbox` (per-agent overrides go in `agents.list[].sandbox`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```jsonc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sandbox": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "mode": "all", // off, non-main, all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "scope": "agent", // session, agent, shared（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "docker": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "image": "openclaw-sandbox:bookworm-slim",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "containerPrefix": "openclaw-sbx-",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // ... more Docker options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "prune": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "idleHours": 24, // Auto-prune after 24h idle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "maxAgeDays": 7, // Auto-prune after 7 days（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sandbox Documentation](/gateway/sandboxing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Agent Configuration](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Doctor Command](/gateway/doctor) - Check sandbox setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
