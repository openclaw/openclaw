---
name: rem-memory
description: Daily REM sleep memory consolidation — reviews sessions and updates long-term memory files.
metadata:
  {
    "openclaw": {
      "emoji": "🧠",
      "requires": {}
    }
  }
---

# AI REM Sleep Memory System

A skill that gives AI assistants human-like REM (Rapid Eye Movement) sleep memory consolidation capabilities.

## Core Concept

Human REM sleep does three things:
- **Consolidates** daily memories into long-term storage
- **Connects** knowledge across different time points
- **Generates** new insights ("connecting the dots")

This skill replicates that process for AI:
```
Daily conversations → daily/ (raw log) → monthly/ (distilled) → MEMORY.md (long-term)
```

## Memory Layer Structure

```
memory/
├── daily/           # Daily raw records (detailed)
├── monthly/         # Monthly summaries (structured)
└── flomo/           # Fragmented thoughts (by tag/date)
```

- **daily/** — What happened, what was discussed, key insights
- **monthly/** — Monthly highlights, breakthroughs, cognitive shifts
- **MEMORY.md** — Distilled long-term memory (essentials only)

## Setup

### Cron Job Configuration

Create an isolated cron job that runs daily during the user's sleeping hours (e.g., 2:00 AM):

```yaml
schedule: "0 2 * * *"
sessionTarget: isolated
payload:
  kind: agentTurn
  message: |
    REM Memory Consolidation task.
    
    1. Read today's session history from:
       $OPENCLAW_STATE_DIR/agents/<agentId>/sessions/*.jsonl
       (Filter by today's date. JSONL format, one JSON object per line.)
    
    2. If conversations exist:
       - Extract key events, insights, decisions, new ideas
       - Write to memory/daily/YYYY-MM-DD.md
       - Check for "deep content" (see Deep Content criteria below)
       - If deep content found: update MEMORY.md
       - Check if monthly/YYYY-MM.md needs updating
       - Cross-day scan: check past 7 days of daily/ for patterns
    
    3. If no conversations:
       - Write "REM: No conversations today." to daily/YYYY-MM-DD.md
       - Do NOT fabricate content
```

### Deep Content Auto-Capture

Promote content to MEMORY.md when any of these conditions are met:
- Contains core cognitive frameworks or mental models
- Forms systematic thinking or formulas
- Reflects personal values or life philosophy
- Summarizes long-term practical experience
- User explicitly requests "record this to memory"

### Cross-Day Connections

Don't just log — connect:
- "Today's thought relates to that conversation last month"
- "Anxious three Tuesdays in a row — possible pattern"
- Identify potential article themes or creative material

## Daily Record Template

```markdown
# YYYY-MM-DD Day of Week

---

## Today: [One-sentence summary of the day's vibe]

### [Time period/Theme 1]
- What happened (concrete events)
- Key details worth remembering
- **Insight:** [Core thought]

### [Time period/Theme 2]
...

---

## Deep Insights (if any)

### [Insight Title]
**Core insight:**
> [Quote or one-line distillation]

**Further thinking:**
- ...
```

## Monthly Record Template

```markdown
# YYYY Month Memory

## [Major Theme 1]
### [Specific Event]
**Date:** YYYY-MM-DD
**Core insight:**
...

## [Major Theme 2]
...
```

## MEMORY.md Update Rules

Only update when:
- New cognitive breakthrough (not repeating existing content)
- Behavioral pattern change
- Important decision recorded
- Workflow optimization

**Do NOT** copy everything from daily/ into MEMORY.md. MEMORY.md is distilled essence, not a dump.

## Production Experience

### One-Week Run Results

| Day Type | Result |
|----------|--------|
| Days with conversations | ✅ Full extraction: events + insights + materials |
| Days without conversations | ✅ Correctly marked "missing" — no fabrication |

### Verified Benefits

1. **Cross-session continuity** — User says "that thing we discussed yesterday" and AI can retrieve it
2. **Creative material accumulation** — Daily experiences auto-archived for article/novel writing
3. **Cognitive pattern detection** — Discovered cross-day behavioral patterns
4. **Novel writing reference** — Yoga class details, camping experiences auto-became novel material

### Important Notes

- Never fabricate what the user didn't say
- Use the user's first-person perspective in records
- Distill, don't dump — MEMORY.md is essence only
- Conversation summaries (session compaction) and file memory are complementary, not replacements

## Extension Ideas

- [ ] Auto-generate weekly/monthly summary reports
- [ ] Proactive reminders based on memory ("You mentioned that plan last week — how's it going?")
- [ ] Semantic search across time points for better cross-day connections
- [ ] Multi-user memory isolation
