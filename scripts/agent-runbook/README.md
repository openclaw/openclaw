# Agent Runbook Generator

Automatically generates and maintains a runbook for common agent tasks, collector failures, and recovery steps.

## What It Does

- Extracts recent activity from OpenClaw logs (`commands.log`, `config-health.json`)
- Checks collector service status (systemd or process-based for WSL)
- Summarizes Mission Control DB health
- Generates an Obsidian-compatible Markdown runbook with:
  - Common commands for OpenClaw gateway, sessions, memory, and cron
  - Collector service management (Krain88)
  - Mission Control operations
  - Troubleshooting guides for common failures
  - Wiki links to relevant Obsidian notes

## Usage

```bash
# Generate runbook (outputs to ./agent-runbook.md by default)
./scripts/agent-runbook/generate-runbook.sh

# Custom output path
./scripts/agent-runbook/generate-runbook.sh --output /path/to/runbook.md

# Custom vault root (for Obsidian wiki links)
./scripts/agent-runbook/generate-runbook.sh --vault /path/to/SakVault

# Environment variables
OPENCLAW_HOME=/custom/path/.openclaw ./generate-runbook.sh
```

## Scheduling

Set up a daily cron job via OpenClaw to auto-refresh:

```json
{
  "name": "runbook-daily-refresh",
  "schedule": { "kind": "cron", "expr": "0 6 * * *", "tz": "Europe/Paris" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run the agent runbook generator: execute /home/sak/.openclaw/workspace/scripts/agent-runbook/generate-runbook.sh --output /home/sak/SakVault/Agent-Shared/agent-runbook.md and confirm success."
  }
}
```

## Architecture

```
generate-runbook.sh
├── Collects data from:
│   ├── ~/.openclaw/logs/commands.log      (session activity)
│   ├── ~/.openclaw/logs/config-health.json (config health)
│   ├── ~/workspace/krain88/                (collector status)
│   ├── ~/workspace/mission-control/        (MC DB health)
│   └── systemctl / pgrep                   (service status)
├── Generates Markdown runbook
└── Writes to output path (default: ./agent-runbook.md)
```

## Task Reference

- Task ID: `7202d396-9b3f-4228-b870-99ffbd53c0ad`
