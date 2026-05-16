---
name: ff_validate_plan
description: Validate implementation against a plan using Codex subagents, local commands, and code review
---

# Validate Plan

Validate whether the implementation satisfies the provided plan. This is a quality gate, not a rubber stamp. Fastflow runs Codex with multi-agent support enabled by default, so use subagents for independent review slices when that improves coverage.

## Operating Rules

- Read the plan fully before validating.
- Compare claimed completion against actual file changes.
- Run every relevant automated verification command that is safe and available.
- Use subagents for independent review areas such as tests, API behavior, UI behavior, or migration safety.
- Do not delegate the final pass/fail decision.
- Report failures plainly; do not mark validation successful when checks fail.
- Manual checks should be listed separately and left for a human when they cannot be automated.

## Process

1. Locate and read the plan file.
2. Inspect git status, recent commits, and diffs to understand what changed.
3. Spawn bounded review subagents when the diff spans independent areas.
4. Map each implementation step or phase to actual file changes.
5. Run the plan's verification commands, or the closest documented repo checks.
6. Write a validation report in the final response. If the repo expects an artifact, also write it under thoughts/shared/validation/.

## Report Format

```markdown
## Validation Report: {plan name}

### Result

PASS or FAIL

### Evidence Reviewed

- `path/to/file:line` - {what was checked}
- `command` - {result}

### Subagent Findings

{subagent summaries used, or "None"}

### Plan Coverage

- Step 1: PASS/FAIL - {reason}
- Step 2: PASS/FAIL - {reason}

### Automated Verification

- PASS/FAIL `command` - {summary}

### Manual Verification Needed

- {manual check, if any}

### Issues To Fix

- {blocking issue or risk}
```

Return FAIL if implementation evidence is missing, required checks fail, or important plan steps are incomplete.
