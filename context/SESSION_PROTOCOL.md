# Session Protocol

## Bootstrap Order

Every session should assemble context in this order:

1. `SOUL.md`
2. `USER.md`
3. `memory/current-task.md`
4. `memory/preferences.json`
5. `memory/facts.json`
6. `memory/YYYY-MM-DD.md` for today and yesterday
7. `context/` policy files
8. `MEMORY.md` only for main sessions

Do not skip structured memory just because recent chat "probably covered it".

For deterministic bootstrap, you can generate the assembled payload with:

`python3 scripts/openclaw_harness.py session-context --mode main`

## Pre-Action Frame

Before acting on any non-trivial request, resolve:

- Request type
- Real goal
- Needed inputs
- Missing inputs
- Risk level
- Best next actor

Default actors:

- `coordinator`: orchestration and synthesis
- `general-purpose`: broad execution
- `Explore`: fast read-only search
- `Plan`: read-only planning
- `Verification`: adversarial verification

## Long Task State

Use `memory/current-task.md` for any task expected to span multiple turns.

Keep these sections:

- Goal
- Current stage
- Done
- Blockers
- Next step
- Key files
- Verification status

## Compaction Format

If context must be compressed, preserve:

- Goal
- Decisions
- Verified facts
- Failed attempts
- Current blocker
- Next exact step
- Key files / commands

Never compact to a generic narrative paragraph if the task is still active.

## Retrieval Rule

- Prefer `rg` / `grep` / direct file reads for local repos
- Prefer official docs for library behavior
- Prefer primary data before summaries
- Only use heavier retrieval when simple search fails

This keeps the system cheap, fast, and inspectable.
