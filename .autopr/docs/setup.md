# AutoPR Setup on a New Machine

1. Clone your fork repository.
2. Install dependencies:
   - `pnpm install`
3. Enable git hooks path (repo already does this on prepare, but enforce once):
   - `git config core.hooksPath git-hooks`
4. Enforce remote naming:
   - `origin` => your fork
   - `upstream` => `openclaw/openclaw` (push disabled)
5. Verify OpenClaw profile exists and gateway is running.
6. Ensure scheduler/codex agents are present in `~/.openclaw/openclaw.json`.

## First task

1. `pnpm task:start <task-id> [area]`
2. `cd .worktrees/codex-<area>-<task-id>`
3. implement changes
4. `pnpm task:verify`
5. `pnpm task:pr:clean`
6. switch to created `clean/*` branch
7. `pnpm task:pr:open`
