# Octopus Orchestrator — Bootstrap

## What this is

You are about to start (or continue) building the OpenClaw Octopus Orchestrator — a terminal-first distributed orchestration layer for supervising many concurrent agent "arms" across local and remote habitats. The architecture doc set in this directory is the authoritative spec; this file is the entry point for the Ralph-loop-driven build.

## Quick orientation (read first, once)

The doc set is dense. Read in this order on a cold start:

1. **`PRD.md`** — product scope, problem statement, phase ordering
2. **`HLD.md`** — high-level architecture; focus on §OpenClaw Integration Foundation
3. **`LLD.md`** — concrete domain objects, state machines, wire contract
4. **`INTEGRATION.md`** — user-facing surfaces + durability playbook; §Required Upstream Changes matters
5. **`DECISIONS.md`** — 35 accepted decisions; skim for the ones tagged in your current task
6. **`implementation-plan.md`** — milestones, epics, sprint sequence
7. **`CONFIG.md`**, **`TEST-STRATEGY.md`**, **`OBSERVABILITY.md`** — reference when needed

Subsequent cold starts can skim the orientation reads and jump straight to §"Pick up where the loop left off."

## Required environment

Before starting the loop, verify:

- [ ] OpenClaw installed (`which openclaw` returns a path)
- [ ] OpenClaw Gateway reachable (`openclaw health` or equivalent succeeds)
- [ ] Working directory is `~/.openclaw/workspace` and you are on branch `octopus-orchestrator`
- [ ] `git status` is clean under `docs/octopus-orchestrator/`
- [ ] `tmux` is installed (`which tmux` returns a path) — needed for M1 PtyTmuxAdapter work
- [ ] SQLite present (`which sqlite3` returns a path)
- [ ] Node.js present (`which node` returns a path) — needed for TypeBox codegen
- [ ] `scripts/octo-ralph/loop.sh` is executable

If any check fails, fix it before starting. The loop will refuse to proceed otherwise.

## Starting the loop

From `~/.openclaw/workspace`:

```bash
bash docs/octopus-orchestrator/scripts/octo-ralph/loop.sh
```

The loop:

1. Runs pre-task checks (clean worktree, right branch, cost budget not exceeded)
2. Picks the first task in `TASKS.md` with `status: ready` and all `depends_on` satisfied
3. Invokes an OpenClaw native subagent with `PROMPT.md` and the task id
4. The subagent reads context docs listed for the task, implements it, runs `verify`
5. On pass: atomic commit, `TASKS.md` status flipped to `done`, `STATE.md` appended, loop iterates
6. On fail after `MAX_TASK_ATTEMPTS`: writes to `BLOCKED.md`, flips task status to `blocked`, loop iterates to the next task
7. On milestone exit criteria met: loop exits cleanly with `MILESTONE_COMPLETE` status

## Stopping the loop

- **Graceful stop:** `touch docs/octopus-orchestrator/.stop-after-current-task` — the loop finishes its current iteration and exits
- **Hard stop:** `Ctrl-C` or `kill <loop pid>` — whatever task was in flight is abandoned; the pre-task check on next start will catch any half-finished work

## Pick up where the loop left off

After a stop or crash:

1. `git log --oneline -20 docs/octopus-orchestrator/` — recent commits
2. `cat docs/octopus-orchestrator/STATE.md | tail -40` — current task, completed count, token/cost state
3. `cat docs/octopus-orchestrator/BLOCKED.md` — anything needing human attention
4. Re-run `bash docs/octopus-orchestrator/scripts/octo-ralph/loop.sh` — it will resume from the next ready task

## Reading progress

- **`git log docs/octopus-orchestrator/`** — canonical progress history
- **`STATE.md`** — live snapshot: current task, recent completions, cost accumulation, iteration count
- **`TASKS.md`** — task list with statuses (ready, in_progress, done, blocked, deferred)
- **`BLOCKED.md`** — tasks that need human unblocking, with the agent's diagnosis
- **`SESSION-LOG.md`** — turn-by-turn narrative for humans reviewing the project

## Unblocking a blocked task

When `BLOCKED.md` has an entry:

1. Read the entry — it includes task id, attempt count, last error, agent's diagnosis, and proposed resolution
2. If the proposed resolution is correct: apply it manually, flip the task status in `TASKS.md` back to `ready`, clear the `BLOCKED.md` entry
3. If it's not: fix the real issue, clear the entry, optionally add a new task or refine the failing task's acceptance criteria
4. Restart the loop

## Rules the loop enforces

- Only paths under `src/octo/`, `docs/octopus-orchestrator/TASKS.md`, `docs/octopus-orchestrator/STATE.md`, `docs/octopus-orchestrator/BLOCKED.md`, `docs/octopus-orchestrator/SESSION-LOG.md`, and anything listed in a task's `blast_radius` can be modified by an agent run
- All architecture docs (`PRD.md`, `HLD.md`, `LLD.md`, `INTEGRATION.md`, `DECISIONS.md`, `CONFIG.md`, `TEST-STRATEGY.md`, `OBSERVABILITY.md`, `implementation-plan.md`, `landscape-review.md`, `recommendation.md`, `BOOTSTRAP.md`, `PROMPT.md`) are **read-only** to agent runs; changes to them require human review. See `.do-not-touch`.
- One logical task = one commit on the `octopus-orchestrator` branch
- Never `git push`, never force-push, never rewrite history
- Never modify OpenClaw core from outside `src/octo/` (enforced by lint rule once it's installed)
- Cost budget per iteration is checked via OpenClaw's existing token/cost emission; if the running total exceeds `OCTO_RALPH_COST_BUDGET_USD` the loop refuses to start a new task

## First task

On a cold start with no completed tasks: pick `M0-01` from `TASKS.md`. The agent should:

1. Read `BOOTSTRAP.md` (this file, quickly)
2. Read `PROMPT.md` (the loop prompt it's running under)
3. Read `LLD.md` §Spawn Specifications and §Event Schema
4. Implement the task per its acceptance criteria
5. Run `verify`
6. Commit, update state, exit

## Repo conventions

- Branch: `octopus-orchestrator` (do not work on any other branch)
- Commit prefix: `octo:` followed by concise subject line
- Co-author trailer: include the runtime identifier (e.g. `Co-Authored-By: OpenClaw Subagent <...>`)
- Never stage files outside the allowed-write list in `.do-not-touch`

## When the loop is complete

At Milestone 5 exit (per `TEST-STRATEGY.md` + `implementation-plan.md`), the loop stops producing work and `STATE.md` records `PROJECT_COMPLETE`. At that point:

- Memory entry `feedback_octopus_commit_discipline.md` can be retired
- This branch can be merged or cherry-picked into upstream as desired
- The commit-on-every-turn rule can be relaxed

Until then: keep committing.
