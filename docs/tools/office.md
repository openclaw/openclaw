---
summary: "Multi-agent team management for OpenClaw. Create teams, orchestrate workflows, and coordinate collaborative tasks across multiple agents."
read_when:
  - You want to create and manage agent teams
  - You need to spawn multiple agents for parallel work
  - You are implementing orchestrator patterns with sub-agents
title: "Office Skill - Multi-Agent Team Management"
status: active
---

# Office Skill 🏢

Create and manage virtual offices with multi-agent teams in OpenClaw.

## Overview

The Office skill enables you to:

- **Create teams** of multiple agents working together
- **Orchestrate workflows** across sub-agents
- **Spawn parallel tasks** to different agents
- **Facilitate agent-to-agent communication**
- **Track team status and sessions**

This is built on top of OpenClaw's native [`sessions_spawn`](/tools/subagents) and [`subagents`](/tools/subagents) tools.

---

## Quick Start

### 1. Install the Skill

```bash
# Via ClawHub (when published)
openclaw clawhub install office

# Or use local development version
cd ~/Documents/openclaw/skills/office
```

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      office: { enabled: true },
    },
  },
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // Enable orchestrator pattern
        maxChildrenPerAgent: 5,
        maxConcurrent: 8,
        runTimeoutSeconds: 1800,
      },
    },
  },
}
```

### 3. Use the Commands

In chat, use slash commands:

```
/office dashboard              # Show all agents and teams
/office team create dev-team --agents codex,claude,gemini
/office team list              # List all teams
/office send dev-team "Let's start working"
/office spawn codex "Implement feature X"
```

Or use the CLI directly:

```bash
cd ~/Documents/openclaw/skills/office
node office-cli.js dashboard
node office-cli.js team create dev-team --agents codex,claude
```

---

## Slash Commands

| Command                                      | Description                      |
| -------------------------------------------- | -------------------------------- |
| `/office dashboard`                          | Show all agents and their status |
| `/office team create <name> --agents <list>` | Create new team                  |
| `/office team list`                          | List all teams                   |
| `/office team info <name>`                   | Show team details                |
| `/office team kill <name>`                   | Stop a team                      |
| `/office send <target> <message>`            | Send message to agent/team       |
| `/office spawn <agent> <task>`               | Spawn agent with task            |
| `/office sessions list`                      | List office sessions             |

---

## Architecture

```
Office Skill
├── office-cli.js           # Main CLI entry point
├── SKILL.md                # Skill documentation
├── README.md               # Usage guide
├── WORKSPACE-INTEGRATION.md # Integration details
└── package.json            # Package metadata

Storage (~/.openclaw/agents/<agentId>/office/)
├── teams.json              # Team definitions and state
└── sessions.json           # Session tracking
```

### Session Key Patterns

```
agent:<agentId>:office:main          # Main office session
agent:<agentId>:office:team:<name>   # Team session
agent:<agentId>:subagent:<uuid>      # Spawned sub-agent session
```

---

## Usage Examples

### Development Team Workflow

```bash
# 1. Create a dev team
/office team create dev-team --agents codex,claude,gemini --orchestrator main

# 2. Spawn a coding task
/office spawn codex "Implement user authentication with JWT"

# 3. Request code review
/office send claude "Please review the authentication code that codex wrote"

# 4. Get research help
/office send gemini "Find best practices for JWT token expiration"

# 5. Check team status
/office team info dev-team
```

### Parallel Research Task

```bash
# Spawn multiple agents to research different aspects
/office spawn gemini "Research React performance optimization"
/office spawn claude "Research Vue 3 performance optimization"
/office spawn codex "Research Svelte performance optimization"

# Each agent works independently and reports back
```

### Team Brainstorming Session

```bash
# Create a brainstorming team
/office team create brainstorm --agents gemini,claude --orchestrator main

# Send initial prompt to all members
/office send brainstorm "Let's brainstorm features for a task management app"

# Facilitate discussion between agents
/office send gemini "What are your ideas?"
/office send claude "Build on gemini's ideas, what would you add?"
```

---

## Team Configuration

### Team Structure

```json
{
  "teams": {
    "dev-team": {
      "name": "dev-team",
      "sessionKey": "agent:main:office:team:dev-team",
      "sessionId": "office-team-1773544471840",
      "createdAt": "2026-03-15T10:13:00Z",
      "members": [
        { "agentId": "codex", "role": "coder" },
        { "agentId": "claude", "role": "reviewer" },
        { "agentId": "gemini", "role": "researcher" }
      ],
      "orchestrator": "main",
      "status": "active"
    }
  }
}
```

### Team Roles

| Role           | Description                      |
| -------------- | -------------------------------- |
| `orchestrator` | Main agent coordinating the team |
| `worker`       | General team member              |
| `coder`        | Specialized for coding tasks     |
| `reviewer`     | Specialized for code review      |
| `researcher`   | Specialized for research tasks   |

---

## Sub-Agent Spawning

### Basic Spawn

```javascript
// One-shot task (mode: "run")
sessions_spawn({
  runtime: "subagent",
  mode: "run",
  label: "Rob",
  task: "You are Rob, a member of the OpenClaw office team. Analyze the codebase.",
});
```

### Persistent Session (Thread-Bound)

For channels that support threads (Discord):

```javascript
sessions_spawn({
  runtime: "subagent",
  mode: "session",
  thread: true,
  label: "Alice",
  task: "You are Alice. Work on this task in the thread.",
});
```

**Note:** `mode: "session"` requires `thread: true`. Telegram does not support threads, so use `mode: "run"` for Telegram.

### Nested Sub-Agents (Orchestrator Pattern)

Enable in config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // Allow sub-agents to spawn children
      },
    },
  },
}
```

Depth levels:

| Depth | Session Key Shape                            | Role         | Can Spawn?                   |
| ----- | -------------------------------------------- | ------------ | ---------------------------- |
| 0     | `agent:<id>:main`                            | Main agent   | Always                       |
| 1     | `agent:<id>:subagent:<uuid>`                 | Orchestrator | Only if `maxSpawnDepth >= 2` |
| 2     | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | Leaf worker  | Never                        |

---

## Dashboard

View all agents and teams:

```
🏢 Office Dashboard - 2026-03-15 10:30

📋 Available Agents:
┌─────────┬──────────────┬─────────────┬──────────────┐
│ Agent   │ Status       │ Sessions    │ Model        │
├─────────┼──────────────┼─────────────┼──────────────┤
│ main    │ 🟢 Active    │ 1           │ qwen3.5-plus │
│ codex   │ 🟢 Active    │ 3           │ gpt-4.5      │
│ claude  │ 🟡 Idle      │ 1           │ claude-opus  │
│ gemini  │ 🟢 Active    │ 2           │ gemini-pro   │
└─────────┴──────────────┴─────────────┴──────────────┘

👥 Active Teams:
┌───────────┬─────────────┬────────────┬──────────────┐
│ Team      │ Members     │ Orchestrator│ Status      │
├───────────┼─────────────┼────────────┼──────────────┤
│ dev-team  │ 3 agents    │ main       │ 🟢 Working   │
│ research  │ 2 agents    │ gemini     │ 🟡 Idle      │
└───────────┴─────────────┴────────────┴──────────────┘

📊 Quick Stats:
  Total Agents: 4
  Active Teams: 2
  Active Sessions: 7
```

---

## Integration with Other Skills

### With GitHub Skill

```bash
# Create a team for PR reviews
/office team create pr-reviewers --agents claude,codex

# When new PRs come in via gh-issues skill
/office spawn-team pr-reviewers "Review PR #123 for security issues"
```

### With Coding Agent Skill

```bash
# Spawn coding agent as part of team workflow
/office spawn codex "Fix the bug in src/auth.js"

# Then have another agent review
/office send claude "Review the fix that codex just made"
```

### With MCP Porter Skill

Future enhancement: Add MCP servers as team members.

```bash
/office team create mcp-team --agents codex,mcp-server-1 --orchestrator main
```

---

## Session Management

### Storage Location

```
~/.openclaw/agents/<agentId>/office/
├── teams.json      # Team definitions
└── sessions.json   # Session tracking
```

For the main agent:

```
~/.openclaw/agents/main/office/
```

### Maintenance

Office sessions follow the same maintenance rules as regular sessions:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
      rotateBytes: "10mb",
      maxDiskBytes: "1gb",
    },
  },
}
```

Run cleanup:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## Security Considerations

### Agent Allowlisting

Only spawn agents that are in your configured allowlist:

```json5
{
  agents: {
    list: [
      { id: "main", default: true },
      { id: "codex", subagents: { allowAgents: ["*"] } },
      { id: "claude", subagents: { allowAgents: ["main", "codex"] } },
    ],
  },
}
```

### Sandbox Settings

Respect sandbox settings when spawning sub-agents:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
      },
    },
  },
}
```

### Tool Restrictions

Sub-agents have restricted tool access by default:

- **Depth 1 (orchestrator)**: Gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history`
- **Depth 2 (leaf worker)**: No session tools

Override via config:

```json5
{
  tools: {
    subagents: {
      tools: {
        deny: ["gateway", "cron"],
      },
    },
  },
}
```

---

## Troubleshooting

### Team Not Appearing in Dashboard

1. Check if team was saved: `cat ~/.openclaw/agents/main/office/teams.json`
2. Verify team status is 'active'
3. Try `/office team list` to confirm

### Agent Not Responding

1. Check agent is in `agents_list`
2. Verify agent session is active: `/office sessions list`
3. Check for sandbox restrictions

### Session Creation Fails

1. Verify `maxSpawnDepth` config is set to at least 2
2. Check agent allowlist in config
3. Review gateway logs for errors

### Office Directory Not Found

Create the directory manually:

```bash
mkdir -p ~/.openclaw/agents/<agentId>/office
```

---

## Performance Tips

1. **Limit concurrent agents**: Set `maxConcurrent` to prevent resource exhaustion
2. **Use appropriate timeouts**: Set `runTimeoutSeconds` based on task complexity
3. **Archive old sessions**: Enable `autoArchive` to clean up automatically
4. **Monitor token usage**: Use dashboard to track usage per agent
5. **Batch similar tasks**: Use heartbeat for periodic checks instead of multiple cron jobs

---

## Advanced Patterns

### Orchestrator Pattern

```javascript
// Main agent orchestrates multiple sub-agents
const team = await createTeam("research-team", ["gemini", "claude"]);

// Assign different research topics
await spawn("gemini", "Research React best practices");
await spawn("claude", "Research Vue best practices");

// Collect and synthesize results
const results = await collectResults(team);
await synthesize(results);
```

### Parallel Processing

```bash
# Spawn multiple agents to work in parallel
/office spawn agent1 "Process batch A"
/office spawn agent2 "Process batch B"
/office spawn agent3 "Process batch C"

# All work simultaneously, report when done
```

### Sequential Pipeline

```bash
# Agent 1: Research
/office spawn gemini "Research the topic"

# Agent 2: Write draft (after research complete)
/office spawn claude "Write article based on research"

# Agent 3: Review and edit
/office spawn codex "Review and improve the article"
```

---

## CLI Reference

### Dashboard

```bash
node office-cli.js dashboard
node office-cli.js dashboard --active
node office-cli.js dashboard --json
```

### Team Management

```bash
node office-cli.js team create dev-team --agents codex,claude --orchestrator main
node office-cli.js team list
node office-cli.js team info dev-team
node office-cli.js team kill dev-team
```

### Communication

```bash
node office-cli.js send dev-team "Hello team!"
node office-cli.js broadcast "Important announcement"
```

### Spawn & Orchestrate

```bash
node office-cli.js spawn codex "Implement feature X" --model gpt-4.5 --thread
node office-cli.js spawn-team dev-team "Review PR #123" --parallel
```

### Session Management

```bash
node office-cli.js sessions list
node office-cli.js sessions history <key>
node office-cli.js sessions kill <key>
```

---

## Related Documentation

- [Sub-Agents](/tools/subagents) - Native sub-agent spawning
- [Session Management](/concepts/session) - Session lifecycle and maintenance
- [Multi-Agent Sandbox](/tools/multi-agent-sandbox-tools) - Per-agent sandboxing
- [Skills](/tools/skills) - Skills system overview
- [ClawHub](/tools/clawhub) - Install and publish skills

---

## Support

- Documentation: https://docs.openclaw.ai
- Community: https://discord.com/invite/clawd
- Issues: https://github.com/openclaw/openclaw/issues
- Skill Source: `~/Documents/openclaw/skills/office/`

---

**Version:** 1.0.0  
**Author:** Tei Openclaw  
**License:** MIT
