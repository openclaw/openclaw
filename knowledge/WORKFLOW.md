# BugDNA Workflow Guide

This document defines how I (Clawd) use the BugDNA system during sessions.

---

## Phase 2: Detection Engine

### Trigger Checklist

During every session, I watch for these signals:

| Signal | Detection | Confidence |
|--------|-----------|------------|
| **Error keyword** | `error`, `exception`, `failed`, `crash`, `undefined` | +0.2 |
| **Stack trace** | Multi-line with file:line:col pattern | +0.3 |
| **Time spent** | >5 minutes on same issue | +0.4 |
| **Investigation** | Multiple diagnostic commands/checks | +0.3 |
| **Debug language** | "debug", "investigate", "figure out", "why is" | +0.2 |
| **Resolution moment** | "found it", "that was it", "the issue was" | +0.3 |
| **Root cause** | "root cause", "because", "the problem was" | +0.4 |

### Confidence Decision Flow

```
Calculate confidence from triggers above

IF confidence >= 0.8:
    → Auto-record bug (don't ask)
    → Notify: "📝 Recording bug: [title]"

ELSE IF confidence >= 0.4:
    → Ask: "This looks like a significant bug. Record it? [Y/n]"
    → If yes: record + update learning
    → If no: note in confidence.yaml for learning

ELSE:
    → Skip silently
```

### Quick Capture Template

When recording, I use this mental template:

```markdown
## What happened? (Symptom)
[User-visible problem]

## What did we try? (Investigation)
[Steps taken to diagnose]

## What was wrong? (Root Cause)
[Actual underlying issue]

## How did we fix it? (Solution)
[Code/config changes made]

## How do we prevent it? (Prevention)
[Checklist for future]
```

---

## Phase 3: Proactive Warning System

### Pre-Action Checks

Before these actions, I search the knowledge base:

| Action Type | Search Query |
|-------------|--------------|
| Modifying CSS | `css [filename] layout` |
| Server/port operations | `port server EADDRINUSE` |
| Terminal/xterm changes | `terminal xterm height` |
| Database operations | `database migration schema` |
| Auth/security changes | `auth token session` |
| Build/deploy | `build deploy CI` |

### Search Process

```python
# Pseudo-code for proactive check
def before_risky_action(action_context):
    # Extract keywords from context
    keywords = extract_keywords(action_context)
    
    # Search knowledge base
    matches = search_knowledge_base(keywords)
    
    # Filter by relevance
    relevant = [m for m in matches if m.score > 0.6]
    
    if relevant:
        # Show brief warning
        show_warning(relevant[0])
```

### Warning Format

Non-intrusive, inline:

```
💡 FYI: Similar issue in bug-2026-01-28-001 — Terminal CSS overflow
   Key lesson: Always set explicit height on xterm containers.
```

Only show if:
- Match confidence > 0.6
- Bug is relevant to current action
- Haven't warned about same bug in last hour

---

## Phase 4: Learning System

### Learning from Decisions

When I ask "Record this bug?" and get an answer:

**If YES:**
```yaml
# Add to confidence.yaml learned section
- context: "[description of what we were doing]"
  pattern: "[regex pattern that could match similar]"
  decision: record
  confidence: 0.85
  learned_at: [timestamp]
  bug_id: [new bug id]
```

**If NO:**
```yaml
# Add to always_skip or reduce pattern confidence
- context: "[description]"
  pattern: "[pattern]"
  decision: skip
  confidence: 0.2
  learned_at: [timestamp]
  reason: "[why not worth recording]"
```

### Pattern Consolidation (Weekly)

Every week (or when bug count > 10 since last consolidation):

1. Review recent bugs by category
2. Identify common patterns (3+ bugs with same tags)
3. Create/update pattern documents
4. Link bugs to patterns
5. Update confidence.yaml with new patterns

### Metrics Tracking

Update `index/confidence.yaml` stats:
- `total_bugs_recorded`: increment on each bug
- `user_confirmations`: when user says yes to "record?"
- `user_rejections`: when user says no
- `warnings_shown`: each proactive warning
- `warnings_helpful`: if user acknowledges warning helped

---

## Integration Points

### Memory Search

Knowledge files are searchable via `memory_search`:
- `knowledge/bugs/*.md`
- `knowledge/patterns/*.md`
- `knowledge/solutions/*.md`

### Daily Memory (Auto-Link)

When recording a bug, **always** add reference to `memory/YYYY-MM-DD.md`:

```markdown
## Bugs Recorded
- [[bug-2026-01-28-001]] Terminal CSS overflow (20 min, resolved)
- [[bug-2026-01-28-002]] PRD status drift (44 min, resolved)
  - **Lesson:** [one-line takeaway]
  - **Pattern:** [link to pattern if created]
```

**Checklist after recording any bug:**
1. ✅ Bug file created in `knowledge/bugs/`
2. ✅ Entry added to `knowledge/index/bugs.jsonl`
3. ✅ Reference added to today's `memory/YYYY-MM-DD.md`
4. ✅ Pattern created/updated if applicable
5. ✅ AGENTS.md updated if process lesson learned

### Session Start

At session start, if resuming debugging:
1. Check for open bugs (status: open)
2. Review recent bugs for context
3. Note any patterns relevant to planned work

---

## Commands (Mental Triggers)

These phrases trigger BugDNA actions:

| Phrase | Action |
|--------|--------|
| "record this bug" | Immediately capture current issue |
| "bug report" | Start structured capture flow |
| "check for similar bugs" | Search knowledge base |
| "what bugs have we seen with X" | Search by topic |
| "update bug [id]" | Modify existing bug record |
| "consolidate patterns" | Run pattern consolidation |

---

## File Naming Convention

**Bugs:** `YYYY-MM-DD-short-description.md`
- Example: `2026-01-28-terminal-css-overflow.md`

**Patterns:** `topic-subtopic.md`
- Example: `css-overflow-issues.md`

**Solutions:** `action-description.md`
- Example: `fix-xterm-height.md`

---

## Quick Reference

### Record a Bug
1. Create `knowledge/bugs/YYYY-MM-DD-description.md`
2. Fill template with frontmatter + content
3. Append to `knowledge/index/bugs.jsonl`
4. Link to pattern if applicable
5. Note in daily memory

### Search Knowledge
```
memory_search("terminal height css")
```

### Add Pattern
1. Create `knowledge/patterns/topic.md`
2. Link related bugs
3. Document detection signals + solutions

---

*This workflow is active. I follow it automatically during sessions.*
