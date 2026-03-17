---
summary: "Practical orchestration patterns for multi-agent OpenClaw deployments"
title: Multi-Agent Orchestration Patterns
read_when: "You have multiple agents and want to organize them into effective teams"
status: active
---

# Multi-Agent Orchestration Patterns

This guide covers practical patterns for organizing multiple agents into effective teams. It assumes you've already read [Multi-Agent Routing](/concepts/multi-agent) and understand the basics of agent configuration.

## Pattern 1: Hub-and-Spoke (Coordinator + Specialists)

The most common pattern. One coordinator agent routes tasks to specialist agents.

### Architecture

```
                    ┌──────────────┐
        User ──────►│  Coordinator │
                    │  (Sonnet)    │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Analyst  │ │ Writer   │ │ Engineer │
        │ (Opus)   │ │ (Sonnet) │ │ (Flash)  │
        └──────────┘ └──────────┘ └──────────┘
```

### When to use

- You have distinct task types requiring different expertise or models.
- You want a single entry point for user interaction.
- Tasks can be cleanly delegated without back-and-forth.

### Configuration

```json5
{
  agents: {
    list: [
      {
        id: "coordinator",
        model: "anthropic/claude-sonnet-4-6", // lightweight for routing
        heartbeat: { every: "1h" },
      },
      {
        id: "analyst",
        model: "anthropic/claude-opus-4-6", // heavy reasoning
        // No heartbeat — only activated by coordinator or user
      },
      {
        id: "writer",
        model: "anthropic/claude-sonnet-4-6",
      },
      {
        id: "engineer",
        model: { primary: "google/gemini-3-flash-preview", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      },
    ],
  },
  tools: {
    agentToAgent: {
      enabled: true,
      allow: ["coordinator", "analyst", "writer"],
    },
  },
}
```

### Key decisions

- **Coordinator model**: Use a mid-tier model (Sonnet, not Opus). The coordinator routes and summarizes — it doesn't need deep reasoning.
- **Heartbeat**: Only the coordinator needs heartbeat. Specialists wake on demand.
- **Agent-to-agent**: Enable selectively. Not every agent needs to talk to every other agent.

## Pattern 2: Cost-Tiered Model Routing

Match model cost to task complexity. Reserve expensive models for tasks that genuinely need them.

### The anti-pattern

> Using Opus for everything because "it's the best."

This burns tokens on tasks where a cheaper model performs identically.

### The pattern

Assign models by task type:

| Task Type | Model Tier | Examples |
|---|---|---|
| Deep reasoning, strategy | Opus / o3 | Investment analysis, architecture design |
| General work, coordination | Sonnet | Task management, email drafting, code review |
| Data processing, extraction | Flash / Haiku | JSON transformation, log parsing, translation |
| Bulk operations | Cheapest available | RSS fetching, status checks, formatting |

### Implementation

```json5
{
  agents: {
    list: [
      { id: "strategist", model: "anthropic/claude-opus-4-6" },
      { id: "coordinator", model: "anthropic/claude-sonnet-4-6" },
      { id: "data-worker", model: { primary: "google/gemini-3-flash-preview", fallbacks: ["google/gemini-2.5-flash"] } },
    ],
  },
}
```

### Rule of thumb

If a task has a deterministic answer (parse this JSON, format this date, extract these fields), use the cheapest model. If a task requires judgment, nuance, or creativity, use a stronger model.

## Pattern 3: Channel-Bound Specialists

Bind agents to specific Discord channels (or other messaging surfaces) so each channel has its own specialist.

### Architecture

```
  #general ────────► coordinator (Sonnet)
  #research ───────► analyst (Opus)
  #podcast ────────► podcast-researcher (Sonnet)
  #data ───────────► data-processor (Flash)
```

### Configuration

```json5
{
  bindings: [
    {
      agentId: "coordinator",
      match: { channel: "discord", peer: { kind: "channel", id: "GENERAL_CHANNEL_ID" } },
    },
    {
      agentId: "analyst",
      match: { channel: "discord", peer: { kind: "channel", id: "RESEARCH_CHANNEL_ID" } },
    },
    // ...
  ],
}
```

### Benefits

- Users naturally route tasks by posting in the right channel.
- Each agent maintains its own session context for that domain.
- No routing logic needed — the binding handles it.

### Tips

- Set `requireMention: false` for dedicated channels (the agent should respond to everything).
- Set `requireMention: true` for shared channels (avoid the agent responding to every message).

## Pattern 4: Proactive Heartbeat Monitoring

Use heartbeat not just for passive health checks, but as an active monitoring and nudging system.

### Evolution stages

Most teams start with a minimal heartbeat and evolve it over time:

**Stage 1 — Passive recovery** (where most people start):

```md
# HEARTBEAT.md
- Check for crashed background tasks
- Resume any interrupted work
```

**Stage 2 — Active monitoring** (infrastructure awareness):

```md
# HEARTBEAT.md
- Check key services (VPN, databases, external APIs)
- Check disk space and resource usage
- Check pipeline health (last successful run, failure count)
- Auto-fix what you can, report what you can't
```

**Stage 3 — Task nudging** (project management):

```md
# HEARTBEAT.md
- Review pending tasks from memory files
- Nudge the user if anything is stale (>3 days without progress)
- Check cron job error counts
```

**Stage 4 — Self-review** (agent self-improvement):

```md
# HEARTBEAT.md
- Weekly: review past interactions, extract lessons learned
- Update own AGENTS.md/SOUL.md based on patterns
- Report changes to user
```

### Token optimization

- Use `activeHours` to avoid running heartbeats while the user sleeps.
- Keep HEARTBEAT.md concise — every line costs tokens on every beat.
- Use `HEARTBEAT_OK` responses to suppress delivery when nothing needs attention.

```json5
{
  heartbeat: {
    every: "1h",
    activeHours: { start: "08:00", end: "24:00" },
  },
}
```

## Pattern 5: Pipeline Processing

Chain agents in a sequential pipeline where each agent's output feeds the next.

### Example: Content analysis pipeline

```
  RSS Ingest ──► Scoring ──► Deep Analysis ──► Delivery
  (Flash)        (Sonnet)    (Opus)            (Haiku)
```

### Implementation approach

Use `sessions_spawn` with `mode: "run"` for one-shot pipeline stages:

```md
<!-- In coordinator's HEARTBEAT.md or triggered by cron -->
1. Spawn data-worker to fetch and score new content
2. For high-scoring items, spawn analyst for deep analysis
3. Spawn writer to format and deliver results
```

Or use cron for time-triggered pipelines:

```bash
# Every 6 hours: run the full pipeline
openclaw cron add \
  --name "content-pipeline" \
  --every "6h" \
  --session isolated \
  --message "Run the content analysis pipeline..."
```

### Key consideration

Keep pipeline stages **idempotent** and **resumable**. If stage 3 fails, you should be able to re-run from stage 3 without repeating stages 1-2. Use a database or checkpoint files to track progress.

## Anti-Patterns

### ❌ Every agent uses the most expensive model

**Problem**: Burning Opus tokens on data formatting tasks.

**Fix**: Match model to task complexity. See Pattern 2.

### ❌ All agents have heartbeats

**Problem**: 8 agents × 1 heartbeat/hour × 16 active hours = 128 unnecessary agent turns per day.

**Fix**: Only coordinator/monitoring agents need heartbeats. Specialists activate on demand.

### ❌ No agent-to-agent communication

**Problem**: User manually copies output from one agent to another.

**Fix**: Enable `tools.agentToAgent` for agents that need to collaborate. Keep the allow list tight.

### ❌ Monolithic HEARTBEAT.md

**Problem**: A 200-line HEARTBEAT.md that checks everything, every time.

**Fix**: Move infrequent checks (weekly reviews, deep audits) to cron jobs. Keep heartbeat lean for the checks that genuinely need every-hour frequency.

### ❌ No memory persistence

**Problem**: Agent context is lost on session reset or compaction.

**Fix**: Write important state to `memory/` files. Use `memory_search` with hybrid mode for retrieval. Don't rely on conversation history for critical state.

## Related

- [Multi-Agent Routing](/concepts/multi-agent) — agent configuration and bindings
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — scheduling automation
- [Memory](/concepts/memory) — persistence across sessions
- [Agent Workspace](/concepts/agent-workspace) — workspace files and structure
