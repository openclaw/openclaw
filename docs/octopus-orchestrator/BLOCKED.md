# Octopus Orchestrator — Blocked Tasks

When the Ralph loop cannot complete a task after `MAX_TASK_ATTEMPTS` retries, it appends an entry here and flips the task's status to `blocked` in `TASKS.md`. A human reviews, resolves, and either:
1. Applies the proposed fix manually, clears the entry, and flips the task back to `ready`
2. Refines the task's acceptance criteria in `TASKS.md` and flips it back to `ready`
3. Marks the task `deferred` in `TASKS.md` and deletes the entry

## Entries
_none yet_

---

## Entry template
```
## <task id> — blocked <ISO timestamp>

**Attempts:** <N>
**Last verify command:** <verify command>
**Last error:**
<error output, truncated to 100 lines>

**Diagnosis:**
<agent's understanding of why this failed>

**Proposed fix:**
<smallest fix the agent can suggest>

**Acceptance criteria assessment:** <correct | needs revision | unclear>
```
