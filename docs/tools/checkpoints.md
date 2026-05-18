---
doc-schema-version: 1
summary: "Hidden git-backed workspace checkpoints before mutating agent tools, with CLI list, diff, and restore commands"
read_when:
  - You want to undo agent file edits
  - You are enabling workspace checkpoint safety
  - You need to inspect or restore checkpointed workspace changes
title: "Workspace checkpoints"
---

Workspace checkpoints create hidden git-backed snapshots of the agent workspace
before mutating tools run. They are meant as a local undo layer for workspaces
that may not be git repositories.

When enabled, OpenClaw attempts one checkpoint per agent turn before these tools
run:

- `write`
- `edit`
- `apply_patch`
- `exec`

The checkpoint store lives outside the workspace under
`$OPENCLAW_STATE_DIR/checkpoints`. OpenClaw does not create or modify a
workspace `.git` directory.

## Enable checkpoints

Add `tools.checkpoints.enabled` to `openclaw.json`:

```json
{
  "tools": {
    "checkpoints": {
      "enabled": true
    }
  }
}
```

Optional limits:

```json
{
  "tools": {
    "checkpoints": {
      "enabled": true,
      "maxSnapshots": 50,
      "maxTotalBytes": 536870912,
      "maxFileBytes": 10485760,
      "maxFiles": 50000,
      "exclude": ["scratch/**"]
    }
  }
}
```

Per-agent overrides use the same shape under `agents.list[].tools.checkpoints`.

## Inspect checkpoints

Use the `checkpoints` CLI with either the active agent workspace or an explicit
workspace path.

```bash
openclaw checkpoints status
openclaw checkpoints list
openclaw checkpoints diff 1
openclaw checkpoints diff latest
```

For a non-agent workspace:

```bash
openclaw checkpoints --workspace /path/to/workspace list
```

Checkpoint references can be:

- a list number, such as `1`
- a commit hash prefix
- `latest`

## Create a manual checkpoint

Manual checkpoints work even when automatic checkpointing is disabled.

```bash
openclaw checkpoints create "before large refactor"
openclaw checkpoints --workspace /path/to/workspace create "before migration"
```

## Restore files

Restore requires `--yes` because it changes workspace files.

Restore the whole workspace to a checkpoint:

```bash
openclaw checkpoints restore latest --yes
```

Restore one file or directory:

```bash
openclaw checkpoints restore latest src/app.ts --yes
```

Before restoring, OpenClaw creates a `pre-restore:<hash>` checkpoint so the
pre-rollback state is still recoverable.

## What is excluded

Checkpoint snapshots skip common generated, dependency, cache, large media, and
secret-like files by default, including:

- `.git`, `.hg`, `.svn`
- `node_modules`, build output, coverage, cache directories
- `.env` and `.env.*`
- `auth-profiles.json`, `credentials/**`
- private key and certificate-like files
- common archive and video formats

Excluded files are not restored. If an excluded file changes between checkpoint
and restore, OpenClaw leaves it as-is.

## Limits

Checkpoints are a local undo layer, not a backup system.

- They only cover files under the selected workspace.
- They do not capture remote state, databases, terminals, or services modified
  by commands.
- Very large workspaces can be skipped by `maxFiles`.
- Files larger than `maxFileBytes` are omitted from snapshots.
- `maxSnapshots` prunes older checkpoint refs per workspace.

For normal source repositories, keep using git branches and commits for durable
history. Use checkpoints as a safety net for agent-driven file changes.
