---
summary: "Documentation for the Gateway host agent runtime boundary — host-level coding-agent CLIs are temporary rescue tools only"
read_when:
  - Enabling or auditing host-level coding-agent access
  - Planning long-running agent work on the Gateway host
title: "Agent runtime boundary"
---

# Agent runtime boundary

The Gateway host agent runtime boundary keeps host-level coding-agent access
scoped as a temporary recovery tool. Long-running agent work should always run
inside the managed Gateway runtime, not from a long-lived authenticated host
CLI.

## Host-level coding-agent CLIs

Host-level coding-agent CLIs (e.g. `codex`, `codex-host`) are **temporary
rescue tools only**. They are not a substitute for the managed Gateway runtime.

### Rules for temporary host agents

- Every temporary host agent must have an **owner**, a **reason**, and a
  **removal window** documented before the agent is enabled.
- Before disabling a host agent, **archive the session state** and keep raw
  logs, transcripts, and auth material out of the repository.
- After archiving, **remove or move live auth material** from the host
  (e.g. `auth.json`) so it cannot be accidentally re-used.
- Replace host entrypoints with a **fail-closed wrapper** or remove them from
  `PATH` so they are not reachable by accident.
- Verify the **managed Gateway runtime** can still list and start agents after
  the host entrypoints are disabled.

## Process cleanup

- Use **daily cleanup** only for clearly orphaned agent processes that have no
  active session or task reference.
- Use **more conservative cleanup** for detached terminal sessions and
  long-running agent shells. Prefer explicit teardown over automatic cleanup
  for these sessions.
- Containerized runtimes (e.g. `codex-container`) are unaffected by host-level
  boundary changes and should be left intact.

## Verification

After applying or updating a host agent runtime boundary:

1. Confirm the host-level entrypoint exits non-zero with the refusal message.
2. Confirm `openclaw gateway status` shows the Gateway runtime is running and
   healthy.
3. Confirm `openclaw agents list` returns expected agents from the managed
   runtime.
4. Confirm no stale host-level agent processes remain after cleanup.

## See also

- [Gateway security overview](/gateway/security/index)
- [Gateway health and diagnostics](/gateway/doctor)
- [Agent runtime architecture](/agent-runtime-architecture)
