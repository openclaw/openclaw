# Office Skill - Multi-Agent Team Management

🏢 Create and manage virtual offices with multi-agent teams in OpenClaw.

## Quick Start

### 1. Install the Skill

```bash
# From the skill directory
cd ~/Documents/openclaw/skills/office

# Or via clawhub (when published)
openclaw clawhub install office
```

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  "skills": {
    "office": {
      "enabled": true
    }
  },
  "agents": {
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5
      }
    }
  }
}
```

### 3. Use the Commands

```bash
# View dashboard
node office-cli.js dashboard

# Create a team
node office-cli.js team create dev-team --agents codex,claude,gemini

# List teams
node office-cli.js team list

# Get team info
node office-cli.js team info dev-team
```

## Slash Commands (In Chat)

Once the skill is loaded, use these commands in your chat:

| Command | Description |
|---------|-------------|
| `/office dashboard` | Show all agents and teams |
| `/office team create <name> --agents <list>` | Create new team |
| `/office team list` | List all teams |
| `/office team info <name>` | Show team details |
| `/office team kill <name>` | Stop a team |
| `/office send <target> <message>` | Send message to agent/team |
| `/office spawn <agent> <task>` | Spawn agent with task |
| `/office sessions list` | List office sessions |

## Example Workflows

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
/office spawn gemini "Research React performance optimization techniques"
/office spawn claude "Research Vue 3 performance optimization techniques"
/office spawn codex "Research Svelte performance optimization techniques"

# Each agent works independently and reports back
```

### Team Brainstorming Session

```bash
# Create a brainstorming team
/office team create brainstorm --agents gemini,claude --orchestrator main

# Send initial prompt to all members
/office send brainstorm "Let's brainstorm features for a new task management app"

# Facilitate discussion between agents
/office send gemini "What are your ideas?"
/office send claude "Build on gemini's ideas, what would you add?"
```

## Architecture

```
Office Skill
├── office-cli.js       # Main CLI entry point
├── SKILL.md            # Skill documentation
├── package.json        # Package metadata
└── README.md           # This file

Storage (~/.openclaw/agents/main/office/)
├── teams.json          # Team definitions and state
└── sessions.json       # Session tracking
```

## Session Key Patterns

```
agent:<agentId>:office:main          # Main office session
agent:<agentId>:office:team:<name>   # Team session
agent:<agentId>:office:sub:<uuid>    # Spawned sub-agent session
```

## API Reference

### loadTeams()

Load team data from storage.

```javascript
const teamsData = loadTeams();
// Returns: { teams: { [name]: TeamDefinition } }
```

### saveTeams(data)

Save team data to storage.

```javascript
saveTeams({ teams: { 'dev-team': teamDefinition } });
```

### getAgentsList()

Get list of available agents from OpenClaw.

```javascript
const agents = getAgentsList();
// Returns: ['main', 'codex', 'claude', ...]
```

### getSessionsList(activeMinutes)

Get list of active sessions.

```javascript
const sessions = getSessionsList(60);
// Returns: { sessions: [SessionInfo, ...] }
```

## Troubleshooting

### Team not appearing in dashboard

1. Check if team was saved: `cat ~/.openclaw/agents/main/office/teams.json`
2. Verify team status is 'active'
3. Try `/office team list` to confirm

### Agent not responding

1. Check agent is in `agents_list`
2. Verify agent session is active: `/office sessions list`
3. Check for sandbox restrictions

### Session creation fails

1. Verify `maxSpawnDepth` config is set to at least 2
2. Check agent allowlist in config
3. Review gateway logs for errors

## Best Practices

1. **Use meaningful team names**: `dev-team`, `research-squad`, `review-board`
2. **Assign clear roles**: Designate orchestrators for complex workflows
3. **Monitor session usage**: Use dashboard to track active sessions
4. **Clean up stopped teams**: Run `openclaw sessions cleanup` periodically
5. **Set appropriate timeouts**: Configure `runTimeoutSeconds` for long tasks

## Security Notes

- Only spawn agents that are in your configured allowlist
- Team sessions are isolated to prevent context leakage
- Respect sandbox settings when spawning sub-agents
- Review team members before granting access to sensitive tasks

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a PR

## License

MIT License - See LICENSE file for details.

## Support

- Documentation: https://docs.openclaw.ai
- Community: https://discord.com/invite/clawd
- Issues: https://github.com/openclaw/openclaw/issues
