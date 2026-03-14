---
title: Failure Summary Template
summary: Lightweight format for reliability debugging and contributor handoff.
read_when:
  - Reporting operational regressions
  - Handing off incidents to PRs
  - Documenting reliability incidents for follow-up work
---

# Failure Summary Template

Use this format when reporting reliability issues (timeouts, reconnect loops, post-update behavior changes, config drift).

The goal is to make every report actionable and reproducible.

## 5-field format

1. **Trigger / Context**
   - What action or schedule triggered the issue?
   - Include environment (channel, OS, version, model) when relevant.

2. **Symptom**
   - What failed or behaved incorrectly?
   - Include exact error text/log snippet if available.

3. **Probable Root Cause**
   - Best current hypothesis.
   - If uncertain, list top 1-2 candidates.

4. **Applied Fix**
   - What change was made?
   - Prefer concrete config keys, commands, or code path references.

5. **Verification Step**
   - How did you confirm the fix?
   - Include command/output, or a deterministic re-run path.

## Copy/paste report block

```md
## Failure Summary

- Trigger / Context:
- Symptom:
- Probable Root Cause:
- Applied Fix:
- Verification Step:
```

## Example

```md
## Failure Summary

- Trigger / Context: After upgrading OpenClaw from 2026.2.24 to 2026.3.2, `openclaw status` reported gateway unreachable.
- Symptom: `gateway connect failed: pairing required`
- Probable Root Cause: New runtime required operator pairing approval after service restart.
- Applied Fix: Ran `openclaw devices list` then `openclaw devices approve --latest`.
- Verification Step: `openclaw status --deep` returned Gateway reachable and channels OK.
```

## Notes

- This is intentionally lightweight: it should take 2-5 minutes to fill.
- If issue spans multiple incidents, submit one summary per incident.
- For security vulnerabilities, use the dedicated process in [Out of Scope](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#out-of-scope).
