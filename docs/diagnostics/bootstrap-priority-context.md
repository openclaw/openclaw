# Prioritized bootstrap context loading

## Summary

When bootstrap docs are too large, truncation can drop critical policy text and degrade agent behavior.
A deterministic priority order helps keep the most important rules always available.

## Proposed behavior

Load bootstrap context in priority order:

1. `SOUL.md`
2. `HARD_EXECUTION_RULES.md`
3. Compact `AGENTS.md`
4. Optional extras

If truncation still occurs, surface explicit diagnostics showing which file/section was dropped.

## Why this matters

- Prevents silent loss of high-priority execution rules
- Improves reproducibility under token pressure
- Reduces timeout/retry loops caused by degraded context

## Acceptance criteria

- High-priority sections are never silently truncated
- Logs display deterministic inclusion order
- Truncation diagnostics include file/section details

## Related discussion

See local draft: `.github/openclaw-pr-draft-bootstrap-priority.md`.
