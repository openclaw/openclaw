---
name: office
description: Multi-agent team management for OpenClaw. Create teams, orchestrate agent-to-agent workflows, manage sessions, and coordinate collaborative tasks across multiple agents. Use when you need to: (1) Create and manage agent teams, (2) Spawn multiple agents for parallel work, (3) Facilitate agent-to-agent communication, (4) Track team status and sessions, (5) Implement orchestrator patterns with sub-agents.
---

# Office Skill - Multi-Agent Team Management

**Location:** `~/Documents/openclaw/skills/office/`

**Purpose:** Create a virtual office environment for managing multi-agent teams, enabling agent-to-agent communication, and orchestrating collaborative workflows.

## Features

### 1. Agent Dashboard (`/office dashboard`)
- List all available agents in the system
- Show active sessions per agent
- Display token usage, model info, and status
- Filter by active/inactive agents

### 2. Team Creation (`/office team create <name>`)
- Select multiple agents to form a team
- Create a shared session for team collaboration
- Assign roles (orchestrator, worker, specialist)

### 3. Team Management (`/office team list|info|kill`)
- List all active teams
- View team composition and session details
- Kill/stop team sessions

### 4. Agent Communication (`/office send <agent|team> <message>`)
- Send messages to specific agents
- Broadcast to entire teams
- Facilitate agent-to-agent coordination

### 5. Session Orchestration (`/office spawn <agent> <task>`)
- Spawn sub-agent sessions with specific tasks
- Support for persistent team sessions
- Track completion and collect results

## CLI Commands

```bash
# Dashboard
/office dashboard              # Show all agents and their status
/office dashboard --active     # Show only active agents
/office dashboard --json       # JSON output

# Team management
/office team create <name> --agents <agent1,agent2,...> [--orchestrator <agent>]
/office team list              # List all teams
/office team info <name|key>   # Show team details
/office team kill <name|key>   # Stop a team session

# Communication
/office send <agent|team> <message>
/office broadcast <message>    # Send to all active agents

# Spawn & Orchestrate
/office spawn <agent> <task> [--model <model>] [--thread] [--persistent]
/office spawn-team <team> <task> [--parallel]

# Session management
/office sessions list          # List all office-related sessions
/office sessions history <key> # View session history
/office sessions kill <key>    # Stop a session
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    office: {
      enabled: true,
      defaultOrchestrator: "main",
      maxTeamSize: 10,
      sessionPrefix: "office",
      autoArchive: true,
      archiveAfterMinutes: 120,
    }
  },
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2,      // Enable orchestrator pattern
        maxChildrenPerAgent: 5,
        maxConcurrent: 8,
        runTimeoutSeconds: 1800,
      }
    }
  }
}
```

## Implementation Details

### Tool Usage

| Tool | Purpose |
|------|---------|
| `agents_list` | Get available agent IDs for spawning |
| `sessions_list` | List active sessions |
| `sessions_spawn` | Create new agent sessions (subagent or ACP) |
| `sessions_send` | Send messages to other sessions |
| `sessions_history` | Read context from other sessions |
| `subagents` | Manage spawned sub-agents |
| `message` | Deliver results to channels |

### Session Key Patterns

```
agent:<agentId>:office:main          # Main office session
agent:<agentId>:office:team:<name>   # Team session
agent:<agentId>:office:sub:<uuid>    # Spawned sub-agent
```

### Team State Storage

Store team metadata in: `~/.openclaw/agents/<agentId>/office/teams.json`

```json
{
  "teams": {
    "dev-team": {
      "name": "dev-team",
      "sessionKey": "agent:main:office:team:dev-team",
      "sessionId": "uuid-here",
      "createdAt": "2026-03-14T08:00:00Z",
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

## Usage Examples

### Create a Development Team

```bash
/office team create dev-team --agents codex,claude,gemini --orchestrator main
```

This creates:
1. A new team session: `agent:main:office:team:dev-team`
2. Spawns sub-agents for each team member
3. Sets up communication channels

### Spawn a Task to Team

```bash
/office spawn-team dev-team "Review PR #123 for security issues" --parallel
```

Each agent receives the task and works in parallel. Results are collected and summarized.

### Agent-to-Agent Coordination

```bash
/office send codex "Hey, can you check the tests in src/__tests__?"
/office send claude "Please review the code that codex just wrote"
```

### Dashboard View

```
🏢 Office Dashboard - 2026-03-14 08:30

Active Agents:
┌─────────┬──────────────┬─────────────┬──────────────┐
│ Agent   │ Status       │ Sessions    │ Model        │
├─────────┼──────────────┼─────────────┼──────────────┤
│ main    │ 🟢 Active    │ 1           │ qwen3.5-plus │
│ codex   │ 🟢 Active    │ 3           │ gpt-4.5      │
│ claude  │ 🟡 Idle      │ 1           │ claude-opus  │
│ gemini  │ 🟢 Active    │ 2           │ gemini-pro   │
└─────────┴──────────────┴─────────────┴──────────────┘

Active Teams:
┌───────────┬─────────────┬────────────┬──────────────┐
│ Team      │ Members     │ Orchestrator│ Status      │
├───────────┼─────────────┼────────────┼──────────────┤
│ dev-team  │ 3 agents    │ main       │ 🟢 Working   │
│ research  │ 2 agents    │ gemini     │ 🟡 Idle      │
└───────────┴─────────────┴────────────┴──────────────┘
```

## Scripts

### `office-cli.js`

Main CLI entry point for office commands.

### `dashboard.js`

Generate agent and team dashboard views.

### `team-manager.js`

Handle team creation, lifecycle, and state management.

### `orchestrator.js`

Coordinate multi-agent workflows and collect results.

## Security Considerations

1. **Agent Allowlisting**: Only spawn agents in `agents_list` or configured allowlist
2. **Sandbox Inheritance**: Respect sandbox settings when spawning
3. **Session Isolation**: Teams have isolated sessions to prevent context leakage
4. **Permission Checks**: Validate user has permission to manage teams

## Error Handling

| Error | Recovery |
|-------|----------|
| Agent not available | Fall back to alternative agent or notify user |
| Session creation failed | Retry with different parameters |
| Team communication timeout | Mark agent as unavailable, continue with others |
| Resource limits exceeded | Queue task or suggest scaling down |

## Future Enhancements

1. **Persistent Teams**: Teams that survive gateway restarts
2. **Role-based Permissions**: Different access levels for team members
3. **Task Queue**: Priority-based task distribution
4. **Performance Metrics**: Track agent productivity and response times
5. **Integration with MCP**: Connect to external MCP servers as team members
6. **Voice/Video Rooms**: Multi-modal team collaboration

## Related Skills

- `subagents` - Native sub-agent spawning
- `github` - For dev team workflows
- `coding-agent` - Delegate coding tasks
- `mcporter` - Add MCP servers as team members

---

**Version:** 1.0.0  
**Author:** Tei Openclaw  
**License:** MIT
