---
name: meshguard
description: Manage MeshGuard AI agent governance - agents, policies, audit logs, and monitoring.
metadata: {"clawdbot":{"requires":{"bins":["curl","jq"]}}}
---

# MeshGuard

AI agent governance platform. Manage agents, policies, audit logs, and monitor your MeshGuard instance.

## Setup

First-time setup — run the wizard:
```bash
bash skills/meshguard/scripts/meshguard-setup.sh
```
This saves config to `~/.meshguard/config` (URL, API key, admin token).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MESHGUARD_URL` | Gateway URL (default: `https://dashboard.meshguard.app`) |
| `MESHGUARD_API_KEY` | API key for authenticated requests |
| `MESHGUARD_ADMIN_TOKEN` | Admin token for org management & signup |

Config file `~/.meshguard/config` is sourced automatically by the CLI.

## CLI Usage

All commands go through the wrapper script:
```bash
bash skills/meshguard/scripts/meshguard-cli.sh <command> [args...]
```

### Status Check
```bash
meshguard-cli.sh status
```
Returns gateway health, version, and connectivity.

### Agent Management
```bash
meshguard-cli.sh agents list                          # List all agents in org
meshguard-cli.sh agents create <name> --tier <tier>   # Create agent (tier: free|pro|enterprise)
meshguard-cli.sh agents get <agent-id>                # Get agent details
meshguard-cli.sh agents delete <agent-id>             # Delete agent
```

### Policy Management
```bash
meshguard-cli.sh policies list                        # List all policies
meshguard-cli.sh policies create <yaml-file>          # Create policy from YAML file
meshguard-cli.sh policies get <policy-id>             # Get policy details
meshguard-cli.sh policies delete <policy-id>          # Delete policy
```

Policy YAML format:
```yaml
name: rate-limit-policy
description: Limit agent calls to 100/min
rules:
  - type: rate_limit
    max_requests: 100
    window_seconds: 60
  - type: content_filter
    block_categories: [pii, credentials]
```

### Audit Logs
```bash
meshguard-cli.sh audit query                              # Recent audit events
meshguard-cli.sh audit query --agent <name>               # Filter by agent
meshguard-cli.sh audit query --action <action>            # Filter by action type
meshguard-cli.sh audit query --limit 50                   # Limit results
meshguard-cli.sh audit query --agent X --action Y --limit N  # Combined filters
```

Actions: `agent.create`, `agent.delete`, `policy.create`, `policy.update`, `policy.delete`, `auth.login`, `auth.revoke`

### Self-Service Signup
```bash
meshguard-cli.sh signup --name "Acme Corp" --email admin@acme.com
```
Creates a new org and returns API credentials. Requires `MESHGUARD_ADMIN_TOKEN`.

## Workflow Examples

**Onboard a new agent with policy:**
1. Create agent: `meshguard-cli.sh agents create my-agent --tier pro`
2. Create policy: `meshguard-cli.sh policies create policy.yaml`
3. Verify: `meshguard-cli.sh agents list`

**Investigate agent activity:**
1. Query logs: `meshguard-cli.sh audit query --agent my-agent --limit 20`
2. Check agent status: `meshguard-cli.sh agents get <id>`

## API Reference

See `skills/meshguard/references/api-reference.md` for full endpoint documentation.
