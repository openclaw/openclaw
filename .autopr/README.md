# AutoPR System (Fork-local)

This folder is the source of truth for the fork automation system.

## Workflow

1. Start task workspace:
   - `pnpm task:start <task-id> [area]`
2. Implement on `codex/<area>/<task-id>` branch in linked worktree.
3. Verify hard gates:
   - `pnpm task:verify`
4. Create clean branch for upstream PR (strips automation/system files):
   - `pnpm task:pr:clean`
5. Open PR from `clean/*` branch:
   - `pnpm task:pr:open`

## Remote convention (required)

- `origin` must be your personal fork (push target).
- `upstream` must be `openclaw/openclaw` and push-disabled.
- Every feature/fix task goes to upstream as a separate PR from a `clean/*` branch.
- Never push task branches directly to upstream.

## Hard gates

- Branch must be `codex/*/*`.
- Must run in linked worktree.
- System automation files are blocked from task diffs unless
  `OPENCLAW_AUTOPR_ALLOW_SYSTEM_FILES=1`.
- CONTRIBUTING checks for PR readiness:
  - `pnpm build`
  - `pnpm check`
  - `pnpm test`

## Notes

- Keep automation changes in this fork.
- Do not include `.autopr/**` in upstream PRs.
