# Clean-up Log

Date: 2026-05-20
Scope: Local repo worktree items that were already unrelated to the claude-context rollout and were intentionally left untouched.

## Purpose

This file records local repo noise that should be reviewed before any cleanup action.

These items were **not** part of the claude-context MCP rollout.
They were **not** committed or pushed as part of the rollout work.
They should be reviewed by the orchestrator before deletion, restoration, or follow-up commits.

## Current worktree inventory

### Tracked deletion

- `docs/superpowers/specs/2026-05-17-qdrant-workspace-reconciliation-design.md`
  - State: tracked file deleted locally
  - Recommendation: review whether this deletion was intentional before restoring or committing removal

### Untracked paths

- `.codex-tmp/`
  - State: untracked directory
  - Recommendation: likely disposable temp data; verify before deletion

- `Dockerfile.local.bak.20260425T163756Z`
  - State: untracked backup file
  - Recommendation: likely obsolete backup; verify ownership/use before deletion

- `Documents/`
  - State: untracked directory
  - Recommendation: unknown content; inspect manually before cleanup

- `backup.bk.sh`
  - State: untracked script
  - Recommendation: inspect contents and provenance before deletion or adoption

- `docker-compose.yml.bak.localhost-ports-2026-04-13T23-59-00Z`
  - State: untracked backup file
  - Recommendation: likely old stack backup; safe only after human review

- `docker/`
  - State: untracked directory
  - Recommendation: inspect manually; do not delete blindly

- `docs/debug/active-memory-post-debug-report.md`
  - State: untracked doc
  - Recommendation: probably investigation artifact; decide whether to retain under docs or delete

- `docs/help/codebase-search.md`
  - State: untracked doc
  - Recommendation: review for intended product/docs inclusion before cleanup

- `docs/help/skill-creation.md`
  - State: untracked doc
  - Recommendation: review for intended product/docs inclusion before cleanup

- `extensions/memory-core/src/qmd-mcp-maintenance.test.ts`
  - State: untracked test file
  - Recommendation: likely unfinished feature or local patch; inspect before deletion

- `extensions/memory-core/src/qmd-mcp-maintenance.ts`
  - State: untracked source file
  - Recommendation: likely paired with the test above; inspect before deletion

- `openclaw.code-workspace`
  - State: untracked workspace file
  - Recommendation: likely local editor config; usually safe to keep untracked or ignore

- `projects/`
  - State: untracked directory
  - Recommendation: unknown content; inspect manually before cleanup

- `src/infra/outbound/channel-bootstrap.runtime.test.ts`
  - State: untracked test file
  - Recommendation: likely unrelated in-progress test work; inspect before deletion

## Safe cleanup posture

Recommended default:

1. Do **not** bulk-delete everything.
2. Treat backup files, docs, and source/test files separately.
3. Review the deleted tracked spec first, because restoring it may be required before any broad cleanup.
4. Only remove temp/editor/local-backup artifacts after explicit approval.

## Items most likely safe after review

- `.codex-tmp/`
- `Dockerfile.local.bak.20260425T163756Z`
- `docker-compose.yml.bak.localhost-ports-2026-04-13T23-59-00Z`
- `openclaw.code-workspace`

## Items that need content review first

- `Documents/`
- `docker/`
- `projects/`
- `backup.bk.sh`
- `docs/debug/active-memory-post-debug-report.md`
- `docs/help/codebase-search.md`
- `docs/help/skill-creation.md`
- `extensions/memory-core/src/qmd-mcp-maintenance.ts`
- `extensions/memory-core/src/qmd-mcp-maintenance.test.ts`
- `src/infra/outbound/channel-bootstrap.runtime.test.ts`
- `docs/superpowers/specs/2026-05-17-qdrant-workspace-reconciliation-design.md` (deleted tracked file)

## Claude-context rollout commits already prepared for push

- `58851a91fb` — `infra(gateway): bind-mount @zilliz/claude-context-mcp into container`
- `adc9207400` — `infra(gateway): mirror host repo path into container`
- `decf962b43` — `fix(gateway): honor denylist for bundled mcp tools`
- `b26a59de8a` — `docs(claude-context-mcp): record post-debug validation closure`
- `020cad1fe6` — `docs(claude-context-mcp): record final green validation`

This cleanup log is intentionally separate from those rollout commits.
