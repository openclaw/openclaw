# AgentMemory Skill

Persistent memory system for AI agents. Remember facts, learn from experience, and track entities across sessions.

## Installation

```bash
clawdhub install agent-memory
```

## Usage

```python
from src.memory import AgentMemory

mem = AgentMemory()

# Remember facts
mem.remember("Important information", tags=["category"])

# Learn from experience
mem.learn(
    action="What was done",
    context="situation",
    outcome="positive",  # or "negative"
    insight="What was learned"
)

# Recall memories
facts = mem.recall("search query")
lessons = mem.get_lessons(context="topic")

# Track entities
mem.track_entity("Name", "person", {"role": "engineer"})
```

## When to Use

- **Starting a session**: Load relevant context from memory
- **After conversations**: Store important facts
- **After failures**: Record lessons learned
- **Meeting new people/projects**: Track as entities

## Integration with Clawdbot

Add to your AGENTS.md or HEARTBEAT.md:

```markdown
## Memory Protocol

On session start:
1. Load recent lessons: `mem.get_lessons(limit=5)`
2. Check entity context for current task
3. Recall relevant facts

On session end:
1. Extract durable facts from conversation
2. Record any lessons learned
3. Update entity information
```

## Database Location

Default: `~/.agent-memory/memory.db`

Custom: `AgentMemory(db_path="/path/to/memory.db")`
