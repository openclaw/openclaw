---
name: memory-bank
description: Persistent, file-based context that survives compaction, restarts, and session loss.
metadata: { "openclaw": { "emoji": "🧠" } }
---

# memory-bank

A structured memory layer that lives **outside** the session and is never compacted. Gives the agent persistent context across restarts, OOM-kills, and channel switches.

## Problem

Session history is ephemeral. Compaction, restarts, and OOM-kills discard accumulated context. The agent "forgets" user preferences, decisions, and ongoing work. This forces users to repeat themselves every new session.

## How It Works

The Memory Bank is a directory of plain markdown files that the agent reads on boot and writes to at session close:

```
~/.openclaw/agents/<agentId>/memory_bank/
├── activeContext.md     # Current focus — updated every session
├── userContext.md       # Persistent user profile — rarely changes
├── productContext.md    # Agent purpose, personality, config
└── systemPatterns.md    # Learned architecture decisions
```

### Read (on session start)

At boot, the agent reads all memory bank files and receives a compressed context window (<2K tokens) of everything it needs to know. This replaces the need to scroll through thousands of messages.

### Write (on session end)

Before the session closes, the agent appends key insights, decisions, and status updates to `activeContext.md`. This ensures that the next session starts with full context — even after a restart, OOM-kill, or compaction.

## Setup

### 1. Create the memory bank directory

```bash
mkdir -p ~/.openclaw/agents/<agentId>/memory_bank
```

### 2. Create initial files

Each file is plain markdown. Start minimal and let the agent evolve them over time:

**`userContext.md`** — Who the user is:

```markdown
# User Context

- **Name**: [Your name]
- **Role**: [Your role/context]
- **Preferences**: [Communication style, constraints, etc.]
```

**`productContext.md`** — What the agent is for:

```markdown
# Product Context

- **Purpose**: [What this agent does]
- **Personality**: [Tone, style, constraints]
- **Key Goals**: [What success looks like]
```

**`activeContext.md`** — What's happening now (agent-managed):

```markdown
# Active Context

## Current Focus
[Agent fills this in automatically]

## Recent Sessions
[Agent appends session summaries here]
```

**`systemPatterns.md`** — Learned patterns (agent-managed):

```markdown
# System Patterns

## Decisions
[Architecture choices, conventions, preferences learned over time]
```

### 3. Add to agent system prompt

Add this instruction to your agent's system prompt or character file:

```
At the start of every session, read all files in your memory_bank/ directory.
At the end of every session, update activeContext.md with:
- Key decisions made
- Current status of ongoing work
- Important context for the next session
```

## Trigger

Use this skill when:

- The agent starts a new session and needs prior context
- The user says "remember this", "save this", or "update my profile"
- The agent needs to persist a decision across sessions
- Context is lost after a restart or compaction

## Commands

### Read full memory bank

```bash
for f in ~/.openclaw/agents/<agentId>/memory_bank/*.md; do
  echo "=== $(basename $f) ==="
  cat "$f"
  echo ""
done
```

### Update active context

```bash
cat >> ~/.openclaw/agents/<agentId>/memory_bank/activeContext.md << 'EOF'

## Session [DATE]
- [Key insight or decision]
- [Status update]
EOF
```

### Search memory bank

```bash
rg -i "keyword" ~/.openclaw/agents/<agentId>/memory_bank/
```

## Design Principles

1. **Files, not databases** — Plain markdown is portable, version-controllable, and human-readable
2. **Never compacted** — Memory bank exists outside the message history, so compaction can't touch it
3. **Agent-managed** — The agent reads and writes these files autonomously via tool calls
4. **Minimal boot cost** — All four files combined should stay under 2K tokens for fast context loading

## Prior Art

This pattern has been running in production for 3+ months in [Project Athena](https://github.com/winstonkoh87/Athena-Public), an open-source AI agent framework. Full documentation: [Memory Bank docs](https://github.com/winstonkoh87/Athena-Public/blob/main/docs/MEMORY_BANK.md).

## Related Issues

- #21850 — Session continuity breaks after restart
- #21821 — Compaction destroys needed context
- #21818 — Post-compaction hook
- #21802 — Shared bootstrap workspace
- #21853 — Feature request for this pattern
