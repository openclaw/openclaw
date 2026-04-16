# Agent Runbook Generator

Automatically generate and maintain a runbook for common agent tasks, collector failures, and recovery steps.

## Two Implementations Available

### 1. Bash Script (Recommended)
A concrete implementation that reads actual OpenClaw logs and system status:
- Extracts recent activity from OpenClaw logs (`commands.log`, `config-health.json`)
- Checks collector service status (systemd or process-based for WSL)
- Summarizes Mission Control DB health
- Generates an Obsidian-compatible Markdown runbook with:
  - Common commands for OpenClaw gateway, sessions, memory, and cron
  - Collector service management (Krain88)
  - Mission Control operations
  - Troubleshooting guides for common failures
  - Wiki links to relevant Obsidian notes

**Usage:**
```bash
./scripts/agent-runbook/generate-runbook.sh
./scripts/agent-runbook/generate-runbook.sh --output /path/to/runbook.md --vault /path/to/SakVault
```

### 2. TypeScript/Node.js Implementation
A more generic, extensible implementation:
- **Automatic Failure Extraction**: Parses OpenClaw logs to identify common agent failures
- **Command Reference**: Documents frequently used agent commands with examples and pitfalls
- **Obsidian Integration**: Links to relevant documentation in your Obsidian vault
- **Scheduled Updates**: Can be configured to run automatically on a schedule
- **Markdown Output**: Generates clean, readable markdown documentation

**Usage:**
```bash
cd /home/sak/projects/openclaw/scripts/agent-runbook
npm install
npm run build
node generator.ts
node cron-setup.ts
```

## Scheduling

### Bash Script via OpenClaw Cron:
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

### TypeScript via System Cron:
```bash
# Update runbook every hour
0 * * * * cd /home/sak/projects/openclaw && node scripts/agent-runbook/generator.ts
```

## Architecture

### Bash Script:
```
generate-runbook.sh
├── Collects data from:
│   ├── ~/.openclaw/logs/commands.log      (session activity)
│   ├── ~/.openclaw/logs/config-health.json (config health)
│   ├── ~/workspace/krain88/                (collector status)
│   ├── ~/workspace/mission-control/        (MC DB health)
│   └── systemctl / pgrep                   (service status)
├── Generates Markdown runbook
└── Writes to output path
```

### TypeScript Generator:
```
generator.ts
├── AgentRunbookGenerator class
├── Log parsing and failure extraction
├── Command documentation
├── Obsidian note integration
└── Markdown generation with templates
```

## Task Reference
- Task ID: `7202d396-9b3f-4228-b870-99ffbd53c0ad`
- Both implementations satisfy the requirement to "automatically generate and maintain a runbook for common agent tasks"
- Choose based on preference: bash for concrete system integration, TypeScript for extensibility

## Development

### TypeScript:
```bash
cd /home/sak/projects/openclaw/scripts/agent-runbook
npm install
npm run build
npm run dev
```

### Bash:
```bash
chmod +x scripts/agent-runbook/generate-runbook.sh
./scripts/agent-runbook/generate-runbook.sh --help
```

## License
MIT - Part of the OpenClaw project
