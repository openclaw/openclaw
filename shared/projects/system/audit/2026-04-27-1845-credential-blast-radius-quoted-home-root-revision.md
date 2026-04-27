# Credential blast-radius quoted-home/root revision — 2026-04-27 18:45 ET

Task: `6b1e5d55-97aa-47ee-af92-f734ac54ce0a`
Branch/worktree: `/mnt/iris_gateway_data_100gb/repos/openclaw-credential-blast-radius-6b1e5d55` / `rex/credential-blast-radius-6b1e5d55`

## Scope

Handled Iris rereview blocker from `shared/projects/system/audit/2026-04-27-1835-credential-blast-radius-home-globs-iris-rereview.md`.

No credential values were printed, copied, rotated, or mutated. No commit, push, PR, deploy, restart, config write, token rotation, or destructive external call was performed.

## Change

Updated `shell/rm-rf-root` classification to block the remaining catastrophic forms:

- `rm -rf "$HOME"/*`
- `rm -rf '${HOME}'/*`
- `rm -rf ${HOME:?}/*`
- `rm -rf / --no-preserve-root`

Preserved allowed cleanup/non-catastrophic cases:

- `rm -rf /tmp/openclaw-build`
- `rm -rf /home/openclaw/some-specific-dir`
- `rm -rf ~/important-dir`
- `rm -rf $HOME/important-dir`

Added classifier coverage and hook-level coverage for the required forms.

## Verification

Passed:

- direct `node --import tsx` assertions: block=14, allow=4
- `corepack pnpm vitest run src/agents/credential-blast-radius-classifier.test.ts src/agents/pi-tools.before-tool-call.credential-blast-radius.test.ts --reporter=dot` — 2 files, 83 tests
- `corepack pnpm tsgo:core:test`
- `corepack pnpm lint:core`
- `PATH=/tmp/openclaw-pnpm-shim:$PATH corepack pnpm check:changed`

## Status

Local draft remains uncommitted and blocked pending Iris re-review/approval for commit/PR.
