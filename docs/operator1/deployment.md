---
summary: "Deployment guide for the Operator1 multi-agent system — prerequisites, new machine setup, and deployment modes."
updated: "2026-03-22"
title: "Deployment"
---

# Deployment

This guide walks you through setting up Operator1 on a new machine, from installing dependencies to starting the system.

## Prerequisites

| Requirement              | Version           | Notes                            |
| ------------------------ | ----------------- | -------------------------------- |
| Node.js                  | 22+               | Required for gateway and CLI     |
| Git                      | Any recent        | For cloning the repo             |
| Bun                      | Latest (optional) | For QMD, faster script execution |
| pnpm                     | Latest            | Package manager                  |
| 1Password CLI (optional) | Latest            | For credential management        |

**Disk space:** ~2.2 GB additional if using QMD local embeddings.

## New machine setup

### Step 1: Clone and install

```bash
git clone https://github.com/openclaw/openclaw.git ~/dev/operator1
cd ~/dev/operator1
pnpm install
```

### Step 2: Run the onboarding wizard

```bash
pnpm openclaw onboard
```

The wizard walks through:

- API key configuration
- Channel setup (Telegram, WhatsApp, etc.)
- Gateway settings
- Initial auth profiles

### Step 3: Configure the agent hierarchy

Copy the Matrix agents template:

```bash
cp Project-tasks/matrix/matrix-agents.template.json ~/.openclaw/matrix-agents.json
```

Edit `~/.openclaw/matrix-agents.json` to update paths for your home directory. Replace all path placeholders with your actual home directory path.

### Step 4: Add the include directive

Edit `~/.openclaw/openclaw.json` and add the `$include` at the top level:

```json
{
  "$include": ["./matrix-agents.json"],
  ...
}
```

This merges the agent hierarchy into the main config.

### Step 5: Start the Gateway

Operator1 runs as a background process. Start it using the CLI:

```bash
openclaw gateway run
```

### Step 6: Complete Setup via GUI Onboarding

Once the gateway is running, open your browser to:
[http://localhost:5174](http://localhost:5174)

Operator1 will automatically detect the fresh installation and launch the **6-Step Onboarding Wizard**:

1. **Gateway Connection**: Verifies the browser can talk to your local process.
2. **AI Provider**: Configure your primary LLM (Anthropic, OpenAI, Straico, etc.).
3. **Agent Hierarchy**: Activate your core agents (Neo, Morpheus, Trinity) and set workspace paths.
4. **Channels**: Connect Telegram, Discord, or Slack for remote access.
5. **First Task**: Send a test message to verify the end-to-end pipeline.
6. **Finish**: Finalizes the `operator1.db` state and unlocks the dashboard.

---

## Technical Details (Advanced)

While GUI onboarding is recommended, you can manually bootstrap the system if running in a headless environment.

### SQLite State Model

Operator1 uses a single `~/.openclaw/operator1.db` for all runtime state.

- **Migrations**: Automatically applied on startup (v1-v12).
- **Domains**: Data is organized into prefixes like `core_`, `session_`, and `op1_`.

### Manual Workspace Creation

If skipping the wizard:

```bash
# Tier 1 (coordinator)
mkdir -p ~/.openclaw/workspace-operator1

# Tier 2 (department heads)
mkdir -p ~/.openclaw/workspace-{neo,morpheus,trinity}
```

### Step 6: Configure QMD (optional)

If using semantic memory search:

```bash
# Install QMD
bun add -g qmd
```

Add to `~/.openclaw/.env`:

```
PATH=/path/to/bun/bin:${PATH}
```

See [Memory System](/operator1/memory-system) for full QMD configuration.

### Step 7: Create core runtime directories

```bash
for agent in operator1 neo morpheus trinity; do
  mkdir -p ~/.openclaw/agents/$agent/agent
done
```

### Step 8: Start the gateway

```bash
pnpm openclaw gateway run --bind loopback --port 18789
```

On first startup, the gateway automatically:

- Creates `~/.openclaw/operator1.db` (SQLite database in WAL mode)
- Runs schema migrations to the latest version (currently v10)
- Migrates any legacy JSON/YAML state files into SQLite

No manual database setup is needed.

Verify:

```bash
# Check gateway is listening
ss -ltnp | grep 18789

# Check channel status
pnpm openclaw channels status --probe

# Check gateway logs
tail -n 50 /tmp/openclaw-gateway.log

# Verify database health
pnpm openclaw doctor
```

## Deployment modes

### Collocated (recommended for single operator)

All agents run in a single gateway process. This is the current production pattern.

- Single `openclaw.json` + `matrix-agents.json`
- Single process on port 18789
- Simpler management, shared resources

See [Gateway Patterns](/operator1/gateway-patterns) for details.

### Independent (future, for scaling)

Each department runs its own gateway:

1. Create separate config per gateway
2. Assign different ports (18789, 19789, 20789, 21789)
3. Start each gateway independently
4. Configure cross-gateway RPC (when available)

See [Gateway Patterns](/operator1/gateway-patterns) for the full comparison.

## Environment requirements

| Component          | Location                          | Size                |
| ------------------ | --------------------------------- | ------------------- |
| OpenClaw repo      | `~/dev/operator1/`                | ~500 MB             |
| Agent workspaces   | `~/.openclaw/workspace-*/`        | ~50 MB total        |
| Agent runtime dirs | `~/.openclaw/agents/*/`           | Grows with sessions |
| State database     | `~/.openclaw/operator1.db`        | Grows with usage    |
| Project memory     | `~/.openclaw/workspace/projects/` | Per-project         |
| QMD models         | `~/.cache/qmd/models/`            | ~2.2 GB             |
| Config             | `~/.openclaw/openclaw.json`       | ~10 KB              |
| Core hierarchy     | `~/.openclaw/matrix-agents.json`  | ~2 KB               |

## Troubleshooting

### Gateway won't start

- Check port availability: `ss -ltnp | grep 18789`
- Kill existing process: `pkill -9 -f openclaw-gateway`
- Check config validity: `pnpm openclaw config validate`

### QMD not working

- Verify PATH in `~/.openclaw/.env` includes the directory containing the `qmd` binary
- Check QMD binary exists: `which qmd`
- Test manually: `qmd search "test query"`

### Agent not responding

- Verify workspace exists: `ls ~/.openclaw/workspace-{agentId}/`
- Check SOUL.md and AGENTS.md are present
- Verify agent is in `matrix-agents.json`
- Check gateway logs for spawn errors

### Database issues

- Run `pnpm openclaw doctor` to check SQLite health (schema version, WAL status, table integrity)
- **Locked database**: usually caused by a stale gateway process — `pkill -f openclaw-gateway` and restart
- **Schema mismatch**: the gateway auto-migrates on startup; if migration fails, check logs for the specific error
- **Corrupt WAL**: delete `~/.openclaw/operator1.db-wal` and `~/.openclaw/operator1.db-shm`, then restart — SQLite will recover from the main DB file

### Channel connection issues

- Run `pnpm openclaw channels status --probe`
- Run `pnpm openclaw doctor` for diagnostics
- Check channel-specific config in `openclaw.json`

## Related

- [Architecture](/operator1/architecture) — system design overview
- [Configuration](/operator1/configuration) — config file reference
- [Gateway Patterns](/operator1/gateway-patterns) — collocated vs independent
- [Agent Configs](/operator1/agent-configs) — workspace file setup
