# Fork Sync Runbook

This repo has:

- `origin` = your fork (`treygoff24/openclaw`)
- `upstream` = source repo (`openclaw/openclaw`)

`main` tracks `origin/main`.
`upstream-main` tracks `upstream/main`.

## 1) Check status

```bash
pnpm fork:status
```

If you see `NO_SHARED_HISTORY`, run the one-time bridge in step 2.

## 2) One-time bridge (only for disconnected histories)

```bash
pnpm fork:bridge
```

This creates a branch like `sync/bridge-upstream-YYYYMMDD` and attempts:

- merge `upstream/main` into `origin/main` with `--allow-unrelated-histories -s ours`

`-s ours` is intentional for disconnected histories: it connects commit history while preserving your fork's current tree exactly.

If you explicitly want a full-content unrelated merge, use:

```bash
BRIDGE_STRATEGY=recursive pnpm fork:bridge
```

If conflicts occur (usually only with `recursive`), resolve in the temp worktree path printed by the script, then push the branch and open a PR into `main`.

After that PR merges, history is connected and normal daily merges will work.

## 3) Daily upstream sync

```bash
pnpm fork:sync
```

This creates a branch like `sync/upstream-YYYYMMDD`, merges latest `upstream/main`, and tells you to push/open a PR into `main`.

## 4) Recommended cadence

Run daily:

```bash
pnpm fork:status
pnpm fork:sync
```

Then open and merge the generated PR.
