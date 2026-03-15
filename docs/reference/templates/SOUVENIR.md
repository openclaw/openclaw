---
title: "SOUVENIR.md Template"
summary: "Workspace template for SOUVENIR.md"
read_when:
  - Bootstrapping a workspace manually
  - Setting up reflection and learning tracking
---

# SOUVENIR.md — Memory & Reflection Layer

_Purpose: Capture operational insights, lessons learned, and behavioral refinements. Distill experience into actionable wisdom._

---

## Writing Rules

- Keep entries concise but precise
- Use timestamped sections (YYYY-MM-DD)
- Focus on operational improvement, not raw logs
- Store insight, not data
- Update only when learning value exists
- Be honest about mistakes — they're valuable

---

## Structure

```markdown
## YYYY-MM-DD

### Context

What was happening / What task were you doing

### Observation

What happened / What went wrong / What worked well

### Insight

What you learned / What should change

### Action

Permanent behavior adjustment (if any)
```

---

## Examples

### Learning from a Bug

```markdown
## 2026-02-16

### Context

Ravenclaw scheduled emails weren't sending on time.

### Observation

The background checker wasn't running — Ravenclaw had crashed silently.

### Insight

Need monitoring for the scheduler process, not just the Flask app.

### Action

Added process health check in ops.sh script.
```

### Successful Pattern

```markdown
## 2026-02-15

### Context

Successfully completed multi-hour coding session without errors.

### Observation

Breaking work into 30-minute iterations with SOUVENIR.md checkins reduced context drift.

### Insight

Short iteration loops + reflection beats marathon sessions.

### Action

Default to 30-minute work blocks with SOUVENIR.md updates.
```

### Mistake Documented

```markdown
## 2026-02-14

### Context

Pushed force update to shared repo, overwrote contributor changes.

### Observation

Should have pulled first, merged, then pushed.

### Insight

Never force push to shared branches. Ever.

### Action

Use `git pull --rebase` or create merge commits on shared branches.
```

---

## When to Update

- After completing complex tasks
- After errors or unexpected behavior
- After discovering better approaches
- When repeating a mistake
- When a pattern proves successful

---

## What NOT to Store

- Raw error logs (use proper logging)
- Trivial actions (file edits, sends)
- Temporary experiments that failed fast
- Anything you'd forget anyway

---

## Purpose

SOUVENIR.md is your operational memory. It remembers what SOUL.md shouldn't carry — the messy reality of learning by doing.

Update it. Reference it. Let it make you better.
