---
name: memory-sleep
description: Nightly memory consolidation for agents - reduces context drift and catastrophic forgetting between sessions. Use when setting up an agent's "sleep cycle", consolidating daily notes into long-term memory, cleaning stale context, or diagnosing memory/context problems. Inspired by biological NREM+REM sleep cycles. Triggers on "memory consolidation", "sleep cycle", "context drift", "forgetting problem", "clean up memory", "consolidate notes".
---

# Memory Sleep - Agent Memory Consolidation

Biological brains consolidate memories during sleep. Agents don't sleep - but they should.

This skill implements a nightly consolidation cycle that transforms raw daily notes into clean, structured long-term memory. Result: each new session starts with compact, high-signal context instead of bloated raw logs.

## The Problem

Agents accumulate daily notes (10KB+/day) that grow unwieldy. New sessions either:
- Skip reading old notes (losing context)
- Read everything (wasting tokens, hitting limits)
- Read partially (inconsistent recall)

This causes "session drift" - the agent forgets decisions, repeats mistakes, loses project context.

## How It Works

Three-phase consolidation modeled on biological sleep:

### Phase 1: NREM - Stabilize (extract what matters)

Scan daily notes from the last 3 days. For each entry, classify:
- **KEEP** - decisions, outcomes, new facts, action items, lessons learned
- **DISCARD** - routine logs, duplicate info, resolved issues, process narration

### Phase 2: REM - Integrate (connect and structure)

- Update long-term memory file (MEMORY.md) with distilled insights
- Create or update per-project summaries if projects are tracked
- Remove outdated entries from long-term memory
- Resolve contradictions (newer info wins)

### Phase 3: Cleanup

- Compress daily files older than 7 days into weekly summaries
- Remove entries that were fully integrated into long-term memory
- Generate session bootstrap summary (top priorities, open threads, key context)

## Setup

Add a cron job for nightly consolidation. Use a cheaper model (Sonnet) to save costs:

```
Schedule: 0 4 * * * (4:00 AM daily)
Model: sonnet (or equivalent cheaper model)
Session: isolated
Timeout: 300s
```

### Cron prompt template

```
Memory consolidation cycle. Read the skill file at [SKILL_PATH] and follow its phases.

Workspace: [WORKSPACE_PATH]
Daily notes pattern: memory/YYYY-MM-DD.md
Long-term memory: MEMORY.md
```

## Phase 1 Instructions: NREM Stabilize

Read daily note files from the last 3 days (`memory/YYYY-MM-DD.md`).

For each section, apply the KEEP/DISCARD filter:

**KEEP criteria** (any one = keep):
- A decision was made ("we decided to...", "agreed that...")
- New factual information (credentials, URLs, contacts, project details)
- A lesson was learned ("never do X because...", "root cause was...")
- An action item exists and is not yet done
- Relationship/people context that aids future interactions
- Project status changes (launches, blockers, milestones)

**DISCARD criteria** (all must apply):
- Routine operational logs (heartbeat OK, deploy succeeded)
- Process narration ("I then checked...", "running command...")
- Duplicate of information already in long-term memory
- Resolved issues with no lasting lesson
- Temporary debugging output

Extract KEEP items into a structured list grouped by project/topic.

## Phase 2 Instructions: REM Integrate

Read the current MEMORY.md. For each extracted KEEP item:

1. **Already in MEMORY.md?** → Skip (avoid duplicates)
2. **Updates existing entry?** → Edit in place with new info
3. **New information?** → Add to appropriate section
4. **Contradicts existing entry?** → Replace with newer info, note the change

### Per-project summaries

If the agent tracks multiple projects, maintain a compact summary per project:
- Current status (1 line)
- Key contacts
- Last significant event
- Next action / blocker

### Staleness check

Remove entries from MEMORY.md that are:
- More than 30 days old with no recent references
- About completed/cancelled projects with no ongoing relevance
- Superseded by newer information

## Phase 3 Instructions: Cleanup

### Archive old daily files

For daily files older than 7 days:
1. Extract any un-integrated KEEP items (safety net)
2. Create/append to `memory/weekly/YYYY-Www.md` with a compressed summary
3. The original daily file can be kept or archived based on agent preference

### Generate morning briefing

Write a `memory/briefing.md` file containing:
- Top 3 priorities (based on recency and importance)
- Open action items with deadlines
- Key context for likely conversations today
- Any warnings (approaching deadlines, unresolved blockers)

This file should be under 2KB - optimized for fast session bootstrap.

## Metrics

Track consolidation effectiveness in `memory/sleep-log.json`:

```json
{
  "lastRun": "ISO timestamp",
  "dailyFilesProcessed": 3,
  "itemsKept": 12,
  "itemsDiscarded": 45,
  "memoryMdSizeBefore": 8500,
  "memoryMdSizeAfter": 9200,
  "briefingGenerated": true
}
```

## Research

- [Sleep-like replay reduces catastrophic forgetting](https://www.nature.com/articles/s41467-022-34938-7) - Nature Communications, 2022
- [Sleep prevents catastrophic forgetting in spiking neural networks](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1010628) - PLOS, 2022
- [Can sleep protect memories from catastrophic forgetting?](https://elifesciences.org/articles/51005) - eLife, 2020
