---
name: workspace-cleanup-safe
description: Perform safe, non-destructive workspace cleanup planning and execution. Use when users ask to tidy disk usage, remove stale artifacts, or clean project directories without risking data loss.
---

# Workspace Cleanup Safe

Clean workspaces with preview-first behavior.

## Audit first (read-only)

Start with a size/age audit:

- large files/directories
- stale build artifacts
- temporary caches
- duplicate archives/log bundles

## Plan format

Return a cleanup plan with groups:

1. Safe to delete now (re-creatable artifacts)
2. Review before delete (old logs/backups)
3. Keep (source, configs, credentials)

## Execution rule

Require explicit approval before deletion.

Prefer reversible deletion when possible (trash/recycle bin) over permanent delete.

## Verification

After cleanup, report:

- items removed
- space reclaimed
- items skipped intentionally

## Guardrails

- Never delete credentials, config files, or user documents by default.
- Never run destructive recursive deletes without explicit, scoped confirmation.
- If scope is ambiguous, stop and ask.
