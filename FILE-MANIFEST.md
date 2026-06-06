# FILE-MANIFEST — canonical locations for managed host/ops files

**Read this before creating, copying, or editing any operational script or
config on this host.** Every file below has exactly **one** authoritative copy.
Never create a second copy somewhere "more convenient" — divergent duplicates
across the host ↔ container boundary are what caused the 2026-06-04 VPS freeze
(see `projects/incidents/incident-2026-06-04-backup-vps-stagger.md` in the
workspace).

## Rule for all agents (Claude Code, Codex CLI, OpenClaw, humans)

1. To change a managed file, edit it **at the canonical path below**. Do not
   `cp` it elsewhere and edit the copy.
2. The container's `~/.openclaw/scripts/` directory is **not** a script home.
   It holds a `README.md` pointer only. Ops scripts run on the **host** from the
   compose project.
3. If you believe a file needs to exist in two places, make the second one a
   symlink to the first, or stop — it almost certainly does not.
4. Before adding a new managed script, add a row to this manifest.

## Managed ops scripts — canonical path = the compose project (git-tracked)

| File         | Canonical path                              | Runs on | Notes                                                                                                                 |
| ------------ | ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `backup.sh`  | `~/godwind-team-docker/openclaw/backup.sh`  | host    | Git-tracked. Does NOT back up QMD models/indexes (re-downloadable/rebuildable) — see the comment block in the script. |
| `restore.sh` | `~/godwind-team-docker/openclaw/restore.sh` | host    | Git-tracked.                                                                                                          |
| `update.sh`  | `~/godwind-team-docker/openclaw/update.sh`  | host    | Git-tracked. Calls `backup.sh` (same dir) before mutating Docker.                                                     |

## Removed duplicates (2026-06-04 / 2026-06-06 dedup)

All of these were the **old pre-hardening "backs up ALL state" `backup.sh`**
(md5 `b4106ecb…`, 5775 bytes) or the diverged container copy. None were on the
execution path; none carried the QMD I/O-bomb. All deleted:

- `~/.openclaw/scripts/backup.sh` (container copy, the diverged one) — **deleted**,
  replaced by `~/.openclaw/scripts/README.md` redirecting here.
- `~/.openclaw/scripts/backup.bk.sh` (container copy) — **deleted**.
- `~/godwind-team-docker/openclaw/backup.bk.sh` (untracked repo copy) — **deleted** 2026-06-06.
- `~/.openclaw/workspace/scripts/backup.sh` — **deleted** 2026-06-06.
- `~/.openclaw/workspace/Exports/backup.sh` — **deleted** 2026-06-06.

Note: branch worktrees under `.worktrees/` and `.claude/worktrees/` contain their
own `backup.sh` — those are normal git checkouts, pick up the fix when their
branch merges/rebases, and are not duplicates to manage by hand.

## Removed duplicates (2026-06-04 dedup)

- `~/.openclaw/scripts/backup.sh` (container copy) — **deleted**. Was the older,
  pre-hardening lean copy; caused confusion because it diverged from the repo.
- `~/.openclaw/scripts/backup.bk.sh` (container copy) — **deleted**.
- Replaced by `~/.openclaw/scripts/README.md`, which redirects here.
