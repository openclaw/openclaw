# OpenCode CUSTOM FORK Skill for OpenClaw

## Overview

This skill enables OpenClaw to use OpenCode CUSTOM FORK (opencode-fork) for all coding tasks with a rigorous 6-step workflow. The skill ensures zero exceptions to the workflow and always uses the custom server API at `http://localhost:4200`. The custom fork includes autonomous agent coordination, async fixes, and enhanced features specifically for J.A.R.V.I.S. use.

## CUSTOM FORK Features

### Unique to opencode-fork:

1. **Autonomous Agent Coordination System** - State machine for plan/build workflows
2. **Webhook Dispatch** - Real-time coordination events with HMAC signatures
3. **Fixed Async Handler** - Missing await in prompt_async fixed (commit 9d6baa570)
4. **Coordination APIs** - `/coordination/:sessionID/*` endpoints for external agent orchestration
5. **Enhanced for AI Agents** - Designed for J.A.R.V.I.S. and autonomous workflows

### Installation Status

- **Custom Fork Installed**: `/home/john/.local/bin/opencode-datboi6942` (wrapper), `/home/john/.local/bin/opencode-improved` (binary)
- **Repository**: `/home/john/opencode-fork` - Custom fork with autonomous agent features
- **Version**: `01.26.04-datboi6942` (custom wrapper), `0.0.0-dev-202602070558` (binary)

## Starting the CUSTOM FORK Server

### KILL STANDARD OPENCODE FIRST:

```bash
# Stop and disable systemd service
systemctl --user stop opencode.service 2>/dev/null
systemctl --user disable opencode.service 2>/dev/null

# Kill all standard OpenCode processes
pkill -9 -f "opencode.*serve" 2>/dev/null
pkill -9 -f "opencode.*4096" 2>/dev/null
pkill -9 -f "opencode.*4100" 2>/dev/null

# Verify no standard OpenCode running
ps aux | grep -E "(opencode|4096|4100)" | grep -v grep
```

### Start CUSTOM FORK (Port 4200 ONLY):

```bash
/home/john/.local/bin/opencode-datboi6942 serve --port 4200 --hostname 127.0.0.1 > /tmp/opencode-fork.log 2>&1 &
```

Verify server is running:

```bash
curl -s http://localhost:4200/global/health
```

## The 6-Step Workflow (ZERO EXCEPTIONS)

### 1. Project Discussion

- Discuss project details extensively with user
- Define requirements, specifications, architecture
- Document agreed-upon plan

### 2. Plan Mode

- Use OpenCode's Plan Mode (deepseek-reasoner or big-pickle)
- Generate detailed plan with files and structure
- Include architecture, dependencies, implementation approach

### 3. Plan Verification

- Compare generated plan with discussed plan
- Verify adherence to requirements
- Iterate if needed

### 4. Testing Planning

- Create rigorous testing strategy in Plan Mode
- Include unit tests, integration tests, edge cases
- Preemptively solve problems/bugs

### 5. Iterative Development

- Cycle through steps 1-4 for each new feature
- Maintain rigorous planning for all changes

### 6. GitHub Workflow

- Create GitHub repository
- Stage, commit, and push changes
- Use conventional commit messages

## Scripts (Updated for Custom Fork)

### Core Scripts

- `init_project.sh` - Initialize new OpenCode project session (port 4200)
- `plan_mode.sh` - Send prompts to OpenCode in Plan Mode (port 4200)
- `build_mode.sh` - Send prompts to OpenCode in Build Mode (port 4200)
- `github_workflow.sh` - Manage Git and GitHub operations

### Utility Scripts

- `test_server.sh` - Test OpenCode server connection (port 4200)

## Usage Examples

### Starting a New Project

```bash
./scripts/init_project.sh "Todo App"
```

### Creating a Plan

```bash
./scripts/plan_mode.sh "Create comprehensive plan for React Todo app with TypeScript"
```

### Implementing the Plan

```bash
./scripts/build_mode.sh "Implement the Todo app according to approved plan"
```

### GitHub Workflow

```bash
./scripts/github_workflow.sh init "Initial commit: Todo App"
./scripts/github_workflow.sh create-repo
./scripts/github_workflow.sh commit "feat: add user authentication"
./scripts/github_workflow.sh push
```

## API Reference

The skill uses OpenCode CUSTOM FORK local HTTP server API at `http://localhost:4200`. Key endpoints:

- `GET /global/health` - Server health check
- `POST /session` - Create new session
- `POST /session/:id/prompt_async` - Send async message (FIXED in custom fork)
- `GET /session/:id/message` - Poll for responses
- `GET /coordination/:id/state` - Get coordination state (CUSTOM FEATURE)
- `POST /coordination/:id/plan/submit` - Submit rough plan (CUSTOM FEATURE)

See `references/api_endpoints.md` for complete API documentation.

## Configuration

### Server Settings

- Port: 4200 (CUSTOM FORK ONLY)
- Hostname: 127.0.0.1
- Available models: deepseek-chat, deepseek-reasoner, big-pickle (opencode provider)

### Session Management

- Current session ID stored in `/tmp/opencode_current_session.txt`
- Current project name stored in `/tmp/opencode_current_project.txt`

## Coordination Workflow (CUSTOM FEATURE)

### Enable Autonomous Agent Mode:

```bash
export OPENCODE_AUTONOMOUS_AGENT_MODE=true
export OPENCODE_WEBHOOK_URL=https://your-agent.example.com/webhooks
export OPENCODE_WEBHOOK_SECRET=your-secret-key
```

### Workflow Steps:

1. Submit rough plan via `/coordination/:id/plan/submit`
2. Answer clarification questions via `/coordination/:id/plan/answer`
3. Verify comprehensive plan via `/coordination/:id/plan/verify`
4. Monitor build stages via `/coordination/:id/plan/status`
5. Approve stages via `/coordination/:id/build/approve`

## Troubleshooting

### Server Not Running

```bash
# Check if CUSTOM FORK is running
ps aux | grep "opencode.*4200"

# Start CUSTOM FORK
/home/john/.local/bin/opencode-datboi6942 serve --port 4200 --hostname 127.0.0.1 > /tmp/opencode-fork.log 2>&1 &

# Check logs
tail -f /tmp/opencode-fork.log
```

### Standard OpenCode Still Running

```bash
# Force kill all standard OpenCode
sudo pkill -9 -f "opencode.*4096"
sudo pkill -9 -f "opencode.*4100"
sudo systemctl --user stop opencode.service
sudo systemctl --user disable opencode.service
```

### JSON Parsing Errors

Install jq:

```bash
sudo apt-get install jq
```

### Session Issues

Delete session files and restart:

```bash
rm /tmp/opencode_current_session.txt /tmp/opencode_current_project.txt
```

## References

- OpenCode CUSTOM FORK Repository: `/home/john/opencode-fork`
- Custom Commits: 4352d6ed4 (coordination system), 9d6baa570 (async fix)
- Autonomous Agent Documentation: `packages/web/src/content/docs/autonomous-agents.mdx`

## Skill Structure

```
opencode/
├── SKILL.md              # Main skill instructions (UPDATED)
├── README.md            # This file (UPDATED)
├── scripts/             # Executable scripts
│   ├── init_project.sh
│   ├── plan_mode.sh
│   ├── build_mode.sh
│   ├── github_workflow.sh
│   └── test_server.sh
└── references/          # Documentation
    ├── api_endpoints.md (UPDATED)
    └── workflow_examples.md
```

## License

This skill is part of OpenClaw and follows the same licensing terms.
