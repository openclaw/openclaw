# Multi-Agent Group Transcript

Automatic transcript sharing between multiple agents bound to the same group chat on platforms where bots cannot see each other's messages.

## Problem

On Telegram (and Signal), bots cannot read messages sent by other bots in the same group. When multiple AI agents are bound to the same group chat, they respond without knowing what their peers have already said — leading to:

- Redundant responses
- Contradictory information  
- Poor coordination

## Solution

A gateway-level hook that:
1. **Automatically logs** agent responses to a shared transcript file
2. **Injects recent peer entries** into agent context on inbound messages

This removes the need for agents to manually maintain transcript files — the gateway handles it.

## Configuration

Add to `openclaw.json`:

```json5
{
  // Your existing bindings...
  bindings: [
    { agentId: "agent1", match: { channel: "telegram", peer: { kind: "group", id: "-100123456" } } },
    { agentId: "agent2", match: { channel: "telegram", peer: { kind: "group", id: "-100123456" } } }
  ],

  // NEW: Enable transcript for multi-agent groups
  multiAgentGroups: {
    "-100123456": {
      // Path to shared transcript file (supports ~)
      transcriptPath: "~/.openclaw/shared/team-transcript.md",
      
      // How many entries to show each agent (default: 20)
      contextLimit: 20,
      
      // Auto-prune entries older than N hours (default: 48)
      pruneAfterHours: 48,
      
      // Format: "markdown" (human-readable) or "json" (machine-readable)
      format: "markdown"
    }
  }
}
```

## How It Works

### Writing (Post-Response Hook)

When an agent sends a response to a configured group:
1. Hook fires on `message:sent` internal event
2. Checks if platform needs transcript (skips Slack/Discord/IRC)
3. Filters out empty and `NO_REPLY` responses
4. Appends formatted entry to transcript file

### Reading (Context Injection)

When an agent receives a message from a configured group:
1. Reads recent entries from transcript file
2. Filters out the agent's own entries (they see their own history)
3. Filters out entries older than `pruneAfterHours`
4. Injects into system prompt as "Peer Agent Activity" section

### Platform Awareness

The feature automatically detects platforms with native bot-to-bot visibility and becomes a no-op:

| Platform | Transcript Needed? | Reason |
|----------|-------------------|--------|
| Telegram | ✅ Yes | Bots cannot read other bot messages |
| Signal | ✅ Yes | Same limitation |
| WhatsApp | ✅ Yes | Same limitation |
| Slack | ❌ No | OAuth scopes grant full history |
| Discord | ❌ No | Bots see all channel messages |
| IRC | ❌ No | All clients see all messages |

## Context Injection Format

Agents see peer activity like this in their system prompt:

```markdown
## Peer Agent Activity (last 20 entries, up to 48h)
The following shows recent messages from other agents in this group chat.
You cannot see their messages directly — this transcript provides shared context.

### 2026-03-24 21:30:00 - jarvis
Confirmed the deployment is complete. Tests passing.

### 2026-03-24 21:28:00 - forge
Started deployment process. ETA 5 minutes.
```

## Files

```
src/config/types.multi-agent.ts      # Type definitions
src/config/multi-agent-groups.ts     # Config resolution + helpers
src/hooks/bundled/multi-agent-transcript.ts    # Post-response hook
src/context-engine/multi-agent-transcript.ts   # Context injection
test/multi-agent-transcript.test.ts  # Unit tests
```

## Integration

1. Register hook in gateway startup
2. Call `injectMultiAgentTranscript()` in system prompt builder
3. Add `multiAgentGroups` to config schema validation

## Testing

```bash
pnpm test test/multi-agent-transcript.test.ts
```

Covers:
- Config resolution with defaults
- Platform detection
- NO_REPLY filtering
- Entry formatting (markdown + JSON)
- Context injection with peer filtering
- Pruning logic
