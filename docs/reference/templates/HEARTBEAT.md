---
summary: "Migration guide for the retired HEARTBEAT.md workspace file"
title: "Retired HEARTBEAT.md workspace file"
read_when:
  - Migrating an older workspace that still has HEARTBEAT.md
---

# HEARTBEAT.md is retired

OpenClaw no longer creates `HEARTBEAT.md` in new workspaces or reads it at runtime. Periodic checks are ordinary editable automation jobs. Their instructions and scratch live in the shared state database.

Manage the current monitor scratch with the monitor job id from `openclaw automations list --all`:

```bash
openclaw automations scratch <jobId>
openclaw automations scratch <jobId> --set "..."
openclaw automations scratch <jobId> --file notes.md
openclaw automations scratch <jobId> --unset
```

If an older workspace still contains `HEARTBEAT.md`, run `openclaw doctor --fix`. Doctor imports supported July 2026 and later instructions and `tasks:` entries into ordinary jobs and scratch. It verifies the imported data before archiving the original and removing the workspace file. Ambiguous inputs remain recoverable and produce a repair diagnostic. See [Heartbeat migration](/gateway/heartbeat) for delivery changes and backup guidance.

## Related

- [Heartbeat migration](/gateway/heartbeat)
- [Automations CLI](/cli/cron)
- [Doctor](/cli/doctor)
- [Retired heartbeat config](/gateway/config-agents/heartbeat-compaction-and-streaming#agents.defaults.heartbeat)
