# Learnings

## [LRN-20260413-001] correction

**Logged**: 2026-04-13T07:21:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary

When the user explicitly requires repo work inside ~/.openclaw/workspace-devops, do not clone into /home/openclaw/work first.

### Details

I cloned the fork into /home/openclaw/work/openclaw-fork, which fell outside the editable workspace sandbox and immediately created friction for follow-up edits. The correct move was to clone directly into ~/.openclaw/workspace-devops when that location was requested.

### Suggested Action

Default repo clones for active work to the current editable workspace root unless the user explicitly asks for another location.

### Metadata

- Source: user_feedback
- Related Files: AGENTS.md
- Tags: sandbox, workspace, git, correction

---
