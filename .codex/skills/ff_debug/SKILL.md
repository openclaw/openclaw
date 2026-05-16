---
name: ff_debug
description: Investigate a failing Fastflow task or implementation issue with local evidence
---

# Debug

Investigate the issue described by the goal, plan, logs, or user prompt. Use Codex-native actions only: read files, run local commands, inspect git state, and search logs that exist in the repository or documented local paths. Do not assume project-specific HumanLayer services unless the repository itself documents them.

## Operating Rules

- Do not edit files while debugging unless explicitly asked.
- Gather evidence before proposing a fix.
- Prefer reproducible commands over guesses.
- Clearly distinguish confirmed facts from hypotheses.
- If logs or external services are unavailable, say exactly what could not be checked.

## Process

1. Read the goal or plan file if provided.
2. Check git state with `git status`, recent commits with `git log --oneline -10`, and relevant diffs.
3. Search for error text, failing tests, logs, and related code paths.
4. Run the narrowest useful reproduction or validation command when safe.
5. Produce a debug report.

## Debug Report Format

```markdown
## Debug Report

### Problem

{clear statement of the observed issue}

### Evidence

- `command or file:line` - {finding}

### Likely Root Cause

{best explanation, with confidence level}

### Recommended Fix

{specific next change or investigation}

### Verification

- `command` - {what should pass after the fix}

### Unknowns

{anything important that could not be checked}
```
