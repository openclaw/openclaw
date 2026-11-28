---
summary: "Migration guide for the retired HEARTBEAT.md workspace file"
title: "Retired HEARTBEAT.md workspace file"
read_when:
  - Migrating an older workspace that still has HEARTBEAT.md
---

# HEARTBEAT.md is retired

OpenClaw no longer creates `HEARTBEAT.md` in new workspaces or reads it at runtime. Monitoring instructions now live in ordinary automation job scratch in the shared state database.

Manage the current monitor scratch with the monitor job id from `openclaw automations list --all`:

```bash
openclaw automations scratch <jobId>
openclaw automations scratch <jobId> --set "..."
openclaw automations scratch <jobId> --file notes.md
openclaw automations scratch <jobId> --unset
```

If an older workspace still contains `HEARTBEAT.md`, run `openclaw doctor --fix`.
Doctor imports supported instructions into monitor scratch and converts valid
legacy `tasks:` entries into cron jobs. When the legacy file can be retired,
Doctor archives it under the state directory before removing it from the workspace.

A retained file does not necessarily mean migration failed. If importing it
would replace different operator-owned scratch or undo an explicit scratch
unset, Doctor keeps that state and the file for review. Files recreated after
completed migration are also retained without changing the automation.
Review Doctor's notices and the retained instructions before copying anything
into job scratch; editing `HEARTBEAT.md` does not change the running monitor.
See [Heartbeat migration](/gateway/heartbeat#upgrade-an-existing-monitor) for
retained files and blocked imports.

## Related

- [Heartbeat migration](/gateway/heartbeat)
- [Cron CLI](/cli/cron)
- [Doctor](/cli/doctor)
- [Automation policies](/automation/cron-jobs/schedules#monitoring-policies)
