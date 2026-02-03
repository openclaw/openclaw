---
name: bulletproof-memory
version: 1.0.0
description: "Never lose context again. The Write-Ahead Log (WAL) protocol with SESSION-STATE.md gives your agent bulletproof memory that survives compaction, restarts, and distractions. Part of the Hal Stack 🦞"
author: halthelobster
---

# Bulletproof Memory 🦞

**By Hal Labs** — Part of the Hal Stack

Your agent forgets things. Mid-conversation, after compaction, between sessions — context vanishes. This skill fixes that permanently.

## The Problem

Agents lose context in three ways:
1. **Compaction** — old messages get summarized/dropped
2. **Session restart** — agent wakes up fresh  
3. **Distraction** — mid-conversation, agent forgets earlier details

Traditional fix: "Remember to save important things." 

**But agents forget to remember.**

## The Solution: Write-Ahead Log (WAL) Protocol

The key insight: **trigger writes on USER INPUT, not agent memory.**

When the user provides a concrete detail, the agent writes it down BEFORE responding. The agent doesn't have to "remember" to save — the rule fires automatically based on what the user says.

| Old Approach | WAL Approach |
|--------------|--------------|
| "Remember to save important things" | "If user gives detail → write before responding" |
| Triggered by agent memory (unreliable) | Triggered by user INPUT (reliable) |
| Agent forgets to remember | Rule fires automatically |
| Saves after the fact (too late) | Saves before responding (never too late) |

## Quick Setup

### 1. Create SESSION-STATE.md

This is your agent's "hot RAM" — the active working memory that persists across compactions.

Create `SESSION-STATE.md` in your workspace root:

```markdown
# SESSION-STATE.md — Active Working Memory

This file is the agent's "RAM" — the hot transaction log for the current active task.
Chat history is a BUFFER. This file is STORAGE.

---

## Current Task
[What we're actively working on right now]

## Immediate Context
[Key details, decisions, corrections from this session]

## Key Files
[Paths to relevant files for this task]

## Last Updated
[Timestamp]
```

### 2. Add WAL Protocol to AGENTS.md

Add this to your agent's instructions:

```markdown
### WRITE-AHEAD LOG (WAL) PROTOCOL

**The Law:** You are a stateful operator. Chat history is a BUFFER, not storage.
`SESSION-STATE.md` is your "RAM" — the ONLY place specific details are safe.

**Trigger:** If the user provides a concrete detail (name, location, correction, decision):
1. You MUST update `SESSION-STATE.md` IMMEDIATELY
2. You MUST write to the file BEFORE you generate your response
3. Only THEN respond to the user

**Example:** User says "It's Doboce Park, not Duboce Triangle"
- WRONG: Acknowledge, keep chatting, maybe write later
- RIGHT: Update SESSION-STATE.md first, then respond

**Why this works:** The trigger is the user's INPUT, not your memory. You don't have 
to remember to check — the rule fires on what the user says.
```

### 3. Add Recovery Protocol

When context is lost, don't ask "what were we doing?" — recover it yourself:

```markdown
### Compaction Recovery Protocol

**Auto-trigger when:**
- Session starts with `<summary>` tag
- Message contains "truncated", "context limits", "Summary unavailable"
- User says "where were we?", "continue", "what were we doing?"
- You should know something but don't

**Recovery steps:**
1. **FIRST:** Read `SESSION-STATE.md` — this has the active task state
2. Read today's + yesterday's daily notes
3. If still missing context, use `memory_search`
4. Present: "Recovered from SESSION-STATE.md. Last task was X. Continue?"

**Do NOT ask "what were we discussing?" if SESSION-STATE.md has the answer.**
```

### 4. Add Session Startup Sequence

```markdown
## Every Session
Before doing anything else:
1. Read `SESSION-STATE.md` — your active working memory (FIRST PRIORITY)
2. Read your identity files (SOUL.md, USER.md, etc.)
3. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context

Don't ask permission. Just do it.
```

### 5. Add Memory Flush Protocol

Monitor context and flush before you lose it:

```markdown
### Memory Flush Protocol

Monitor your context usage with `session_status`. Flush important context before compaction:

| Context % | Action |
|-----------|--------|
| < 50% | Normal operation |
| 50-70% | Write key points after substantial exchanges |
| 70-85% | Active flushing — write everything important NOW |
| > 85% | Emergency flush — full summary before next response |

**At >60%:** Update SESSION-STATE.md before every reply
**At >80%:** Write comprehensive handoff to daily notes

**What to flush:**
- Decisions made (what was decided and why)
- Action items (who's doing what)
- Open threads (anything unfinished)
- Corrections (things the user clarified)
```

## Why This Works

### The Trigger Insight

Most memory advice fails because it relies on the agent remembering to do something. But forgetting is the problem we're trying to solve!

The WAL protocol succeeds because:
- **Trigger = user input** (external, reliable)
- **Not trigger = agent memory** (internal, unreliable)

When the user says something concrete, the protocol fires. The agent doesn't need to remember anything — the rule activates based on what comes in.

### The SESSION-STATE.md Insight

Daily notes are great for logging what happened. But they're not structured for "what am I doing RIGHT NOW?"

SESSION-STATE.md is:
- **Hot** — the current active task, not history
- **Structured** — current task, context, key files
- **First priority** — read before anything else on startup

It's the difference between a journal and a sticky note on your monitor.

## Pre-Compaction Checklist

Before a long session ends or context gets critical:

- [ ] Current task documented in SESSION-STATE.md?
- [ ] Key decisions captured?
- [ ] Action items noted?
- [ ] User corrections saved?
- [ ] Could future-me continue from SESSION-STATE.md alone?

## Self-Summarization Prompt

When context hits 85%+, ask yourself:

> "If my context resets right now, what does future-me absolutely need to know to continue this task? Write it for someone with zero context."

This produces better summaries than mechanical extraction.

## The Complete Memory Stack

For comprehensive agent memory, combine this with:

| Skill | Purpose |
|-------|---------|
| **Bulletproof Memory** (this) | Never lose active context |
| **PARA Second Brain** | Organize long-term knowledge |
| **Proactive Agent** | Act without being asked |

Together, they create an agent that remembers everything, finds anything, and anticipates needs.

## Example SESSION-STATE.md

Here's a real example of what this looks like in practice:

```markdown
# SESSION-STATE.md — Active Working Memory

## Current Task
Building dashboard for Jordan — Life OS view with goal tracking

## Immediate Context
- Dashboard deployed to: https://halthelobster.github.io/hal-ops-dashboard/
- Added tabs: Operations + Life OS
- Jordan at Moontricks concert @ The Independent tonight
- Correction: It's "Shovelman" (one word), not "Shovel Man"

## Key Files
- Dashboard HTML: /Users/Hal/clawd/dashboard/index.html
- Life OS data: /Users/Hal/clawd/dashboard/life-os.json
- Social events log: notes/areas/social-events.md

## Last Updated
2026-01-29 11:00 PM PST
```

## Principles

1. **Write before responding** — The WAL protocol is non-negotiable
2. **Trigger on input** — User input fires the rule, not agent memory
3. **SESSION-STATE.md is first** — Always read it first on startup
4. **Flush early, flush often** — Don't wait for 85% context
5. **Structure for retrieval** — Future-you needs to continue, not just read

---

*Part of the Hal Stack 🦞*

*Pairs well with [PARA Second Brain](https://clawdhub.com/halthelobster/para-second-brain) for knowledge organization and [Proactive Agent](https://clawdhub.com/halthelobster/proactive-agent) for behavioral patterns.*
