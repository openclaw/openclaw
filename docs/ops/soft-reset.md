---
summary: "Reset mission/behavior without reinstalling integrations"
title: "Soft reset"
---

# Soft reset

A **soft reset** re-aligns assistant behavior (mission, tone, working style) without rebuilding channels, integrations, or local tooling.

Use this when the assistant is off-target, too noisy/passive, or mismatched to current priorities.

## Soft reset vs full reset

### Soft reset
- Rewrites behavior/context files
- Keeps channels, skills, and environment setup
- Usually takes 10–20 minutes

### Full reset
- Rebuilds setup from scratch
- Reconnects channels/integrations
- Use when environment/config itself is broken

## What to rewrite vs keep

### Rewrite (behavior-critical)
- `SOUL.md`
- `USER.md`
- `WORKSTYLE.md`
- `memory/YYYY-MM-DD.md` (add reset marker)

### Usually keep
- `TOOLS.md`
- Channel/integration config
- Installed skills
- Service/environment setup

### Optional cleanup
- Prune outdated sections in `MEMORY.md`
- Archive stale project notes

## 10-minute checklist

1. Rewrite `SOUL.md` for current mission/tone.
2. Update `USER.md` with current goals and preferences.
3. Update `WORKSTYLE.md` with current execution style.
4. Add a dated reset note in today’s memory file.
5. Run one real task as a validation pass.
6. Tune once; avoid repeated micro-edits.

## Validation

- [ ] Tone matches expected vibe
- [ ] Initiative level is appropriate
- [ ] No breakage in channels/tools
- [ ] First post-reset task needed less handholding

## Common mistakes

- Full reinstall for behavior-only issues
- Editing many files before running one test task
- Rotating tokens/channels unnecessarily

## Reset note template

```md
Soft reset performed: YYYY-MM-DD
Reason: [brief]
New mission focus: [brief]
Kept unchanged: integrations/channels/tools
Validation task: [task]
Outcome: [pass/fix needed]
```
