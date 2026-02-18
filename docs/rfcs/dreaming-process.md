# RFC: Dreaming Process — Autonomous Memory Consolidation

## Summary

Add a built-in "dreaming" process that runs during low-activity periods to autonomously consolidate, organize, and reflect on an agent's accumulated memories — similar to how biological brains consolidate memories during sleep.

## Motivation

Today, agents accumulate daily memory files (`memory/YYYY-MM-DD.md`) and a long-term memory file (`MEMORY.md`), but consolidation between them is manual — it only happens when explicitly prompted during heartbeats, or when the user asks. This leads to:

1. **Memory bloat** — Daily files grow indefinitely without cleanup
2. **Stale long-term memory** — `MEMORY.md` becomes outdated as the agent forgets to update it
3. **Lost context** — Important decisions and lessons from daily logs never get promoted to long-term memory
4. **Wasted heartbeats** — Using conversational heartbeats for memory maintenance wastes tokens and response time

## Design

### How It Works

The dreaming process is a **scheduled isolated cron job** that:

1. Runs during configured "quiet hours" (default: 3 AM daily)
2. Checks for recent user activity — skips if user was active within the last hour
3. Reviews the last N daily memory files (default: 7)
4. Reads current `MEMORY.md`
5. Uses a dedicated (preferably cheap) model to consolidate memories
6. Updates `MEMORY.md` with distilled, organized entries
7. Optionally sends a brief summary notification

### Three Modes

| Mode          | What it does                                         | Use case             |
| ------------- | ---------------------------------------------------- | -------------------- |
| `consolidate` | Review daily files → update MEMORY.md                | Default, lightweight |
| `reflect`     | Consolidate + analyze patterns and generate insights | Weekly deep-dive     |
| `organize`    | Consolidate + clean workspace files, update TOOLS.md | Monthly maintenance  |

### Configuration

```yaml
dreaming:
  enabled: true
  schedule: "0 3 * * *" # 3 AM daily
  timezone: "Europe/Lisbon"
  model: "auto" # Uses cheapest available model
  lookbackDays: 7
  mode: "consolidate" # consolidate | reflect | organize
  quietMinutes: 60 # Skip if user active within 60min
  delivery:
    enabled: false # Send dream summary to user?
    channel: "whatsapp"
    to: "+1234567890"
```

### Activity Guard

The dreaming process respects user activity — if the user has been active within `quietMinutes`, the dream is skipped and rescheduled. This prevents the agent from appearing to "talk to itself" during active conversations.

## Advantages

### 1. **Biological Analogy — Memory Consolidation**

Human brains don't store memories during the day and call it done. During sleep, the hippocampus replays experiences and transfers important ones to the neocortex for long-term storage. The dreaming process does exactly this for AI agents — it's the missing piece of the memory lifecycle.

### 2. **Token Efficiency**

Instead of spending expensive conversational tokens on memory maintenance during heartbeats, dreaming uses a cheap model (Haiku-class) in an isolated session. No conversation history to load, no system prompt overhead from the main session.

### 3. **Consistent Memory Quality**

Manual memory consolidation is inconsistent — sometimes the agent remembers to do it, sometimes it doesn't. The dreaming process guarantees regular maintenance, ensuring MEMORY.md stays fresh and useful.

### 4. **Self-Improving Context**

Over time, the agent builds a higher-quality long-term memory because consolidation happens systematically rather than ad-hoc. This means:

- Better responses (more relevant context in MEMORY.md)
- Fewer "I don't remember" moments
- More coherent personality and knowledge across sessions

### 5. **Separation of Concerns**

Memory maintenance is a background infrastructure task — it shouldn't compete with user-facing work for attention or tokens. Dreaming makes this a first-class concern with its own schedule, model, and budget.

### 6. **Workspace Health**

In `organize` mode, the dreaming process also maintains workspace hygiene — updating stale docs, cleaning temp files, and ensuring the agent's self-knowledge (TOOLS.md, HEARTBEAT.md) stays accurate.

### 7. **Personality Development**

The `reflect` mode enables genuine self-reflection — the agent can notice patterns in its own behavior, identify recurring themes, and evolve its understanding over time. This is a step toward agents that genuinely learn from experience.

## Implementation

- **New file**: `src/infra/dreaming.ts` — Config types, prompt builder, cron job builder, activity guard
- **New file**: `src/infra/dreaming.test.ts` — Unit tests
- **Integration**: Uses existing cron infrastructure (no new scheduling system needed)
- **Zero breaking changes**: Disabled by default until explicitly configured

## Future Work

- **Dream journaling**: Save dream summaries to `memory/dreams/` for meta-analysis
- **Cross-agent dreaming**: In multi-agent setups, agents could share consolidated memories
- **Adaptive scheduling**: Dream more frequently during high-activity periods, less during quiet ones
- **Forgetting curve**: Implement deliberate forgetting of low-importance memories to keep context windows small

## References

- [Memory Consolidation in Biological Systems](https://en.wikipedia.org/wiki/Memory_consolidation)
- [Sleep and Memory: The Role of Sleep in Learning and Memory](https://www.nature.com/articles/nrn3170)
- OpenClaw AGENTS.md "Memory Maintenance (During Heartbeats)" section — the manual process this replaces
