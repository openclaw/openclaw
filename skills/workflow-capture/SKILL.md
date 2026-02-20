---
name: workflow-capture
description: Monitors conversations for reusable workflows and prompts to create skills when patterns emerge. Use when (1) a similar task is performed 2-3+ times, (2) a reusable automation pattern becomes evident, (3) Guillermo asks about making something a skill, or (4) we discuss creating a new skill.
---

# Workflow Capture

## Overview

Identifies recurring workflows in our sessions and prompts to capture them as reusable skills. Helps maintain skill hygiene by catching patterns early.

## When to Trigger

This skill should activate when:

1. **Repetition detected**: We do the same/similar task 2-3+ times across sessions
2. **Pattern emerges**: A multi-step workflow becomes routine
3. **Explicit query**: Guillermo asks "should we make this a skill?" or discusses skill creation
4. **Reusable automation**: Any workflow that could be templated or scripted

## How It Works

### 1. Detection

Track these signals:

- Repeated file operations (same scripts, similar edits)
- Recurring multi-step processes
- Guillermo explicitly asking about skills
- Any workflow with 3+ steps that we've done before

### 2. Suggestion Format

When a pattern is detected, prompt Guillermo with:

```
🔄 Workflow Detected: [brief description]
- Seen: [count] times across [sessions/dates]
- Why it's useful: [1-line rationale]
→ Should I create a skill for this? (Y/n)
```

### 3. Skill Creation Flow

If Guillermo agrees:

1. Use **skill-creator** skill to initialize
2. Ask Guillermo for concrete examples of how they'd use it
3. Identify reusable components (scripts, references, assets)
4. Scaffold the skill with `init_skill.py`
5. Write SKILL.md with clear triggers and usage
6. Package with `package_skill.py`

## Example Suggestions

- "We've pushed to 3 different repos the same way — want a `git-multi-push` skill?"
- "This is the 4th time we set up a cron job together — skill?"
- "We're building a skill together — want to save this pattern?"

## Resources

### scripts/

- `scaffold_skill.py` — Optional: quick-scaffold a new skill from a template

### references/

- `skill-template.md` — Reference: example SKILL.md structure

## Notes

- Don't over-trigger — wait for genuine reuse potential (2-3x minimum)
- Keep suggestions brief and actionable
- Always ask before creating; never assume
