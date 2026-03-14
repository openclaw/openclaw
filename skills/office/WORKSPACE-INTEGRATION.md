# Office Skill - Workspace Integration

## Installation

### Option 1: Local Development (Recommended for Testing)

The skill is already created at:
```
~/Documents/openclaw/skills/office/
```

To use it, the skill will be auto-loaded by OpenClaw when you use `/office` commands.

### Option 2: Publish to ClawHub

```bash
cd ~/Documents/openclaw/skills/office
openclaw clawhub publish
```

Then others can install via:
```bash
openclaw clawhub install office
```

## Configuration

### Step 1: Update openclaw.json

Add the following to `~/.openclaw/openclaw.json`:

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

### Step 2: Restart Gateway

```bash
openclaw gateway restart
```

### Step 3: Verify Installation

In chat, send:
```
/office dashboard
```

You should see the dashboard output.

## Storage Location

Office skill stores data at:
```
~/.openclaw/agents/<agentId>/office/
├── teams.json      # Team definitions
└── sessions.json   # Session tracking
```

For the main agent:
```
~/.openclaw/agents/main/office/
```

## Usage in Main Session

### View Dashboard

```
/office dashboard
```

Shows all agents, active sessions, and teams.

### Create a Team

```
/office team create dev-team --agents codex,claude,gemini --orchestrator main
```

### List Teams

```
/office team list
```

### Get Team Info

```
/office team info dev-team
```

### Send Message to Team

```
/office send dev-team "Let's start working on the new feature"
```

### Spawn Agent Task

```
/office spawn codex "Implement user authentication"
```

### List Sessions

```
/office sessions list
```

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

```bash
# Add MCP server as a team member (future enhancement)
/office team create mcp-team --agents codex,mcp-server-1 --orchestrator main
```

## Advanced Patterns

### Orchestrator Pattern

```javascript
// Main agent orchestrates multiple sub-agents
const team = await createTeam('research-team', ['gemini', 'claude']);

// Assign different research topics
await spawn('gemini', 'Research React best practices');
await spawn('claude', 'Research Vue best practices');

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

## Monitoring and Debugging

### Check Active Sessions

```bash
openclaw sessions list --active 60
```

### View Session History

```bash
openclaw sessions history <session-key>
```

### Check Team State

```bash
cat ~/.openclaw/agents/main/office/teams.json
```

### Gateway Logs

```bash
openclaw gateway logs --follow
```

## Cleanup

### Stop a Team

```
/office team kill dev-team
```

### Cleanup All Sessions

```bash
openclaw sessions cleanup --enforce
```

### Remove Office Data

```bash
rm -rf ~/.openclaw/agents/main/office/
```

## Performance Tips

1. **Limit concurrent agents**: Set `maxConcurrent` to prevent resource exhaustion
2. **Use appropriate timeouts**: Set `runTimeoutSeconds` based on task complexity
3. **Archive old sessions**: Enable `autoArchive` to clean up automatically
4. **Monitor token usage**: Use dashboard to track usage per agent

## Security Checklist

- [ ] Only allow trusted agents in `allowAgents` list
- [ ] Set appropriate `maxSpawnDepth` (2 is usually sufficient)
- [ ] Configure sandbox settings if needed
- [ ] Review team members before assigning sensitive tasks
- [ ] Monitor session activity regularly

## Support

For issues or questions:
- Check `~/Documents/openclaw/skills/office/README.md`
- Visit https://docs.openclaw.ai
- Join Discord: https://discord.com/invite/clawd
