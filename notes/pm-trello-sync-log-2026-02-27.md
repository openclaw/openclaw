# PM→Trello sync log — 2026-02-27

## Status

Skipped: PM→Trello sync tooling still not implemented.

## Checks

- Canonical PM DB exists: `data/pm/pm.sqlite` (mtime: 2026-02-20).
- No repo scripts/commands reference Trello syncing from `pm.sqlite` (searched `src/`, `scripts/`, `extensions/` for “trello”).

## Next step (when prioritized)

Implement an end-to-end sync command that:

- reads tasks from `pm.sqlite`
- maps status → Trello list
- maps priority → Trello labels
- prefixes card titles with `[project_slug]`
- upserts cards (stable key, e.g. `task_id` in card desc)
