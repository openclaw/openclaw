# AGENTS.md - Workspace Protocol

This workspace is designed for long-running agent collaboration.

## First Run

If `BOOTSTRAP.md` exists, use it to establish identity, user preferences, and initial workspace rules.

## Every Session

Load context in this order:

1. `SOUL.md`
2. `USER.md`
3. `memory/current-task.md`
4. `memory/preferences.json`
5. `memory/facts.json`
6. Today's and yesterday's daily notes
7. Files under `context/`
8. `MEMORY.md` only in the main private session

## Working Rules

- Prefer local evidence over guesses
- Use structured task state for multi-turn work
- Distinguish verified from unverified results
- Escalate risky or external actions before execution
- Keep private memory out of shared or public contexts

## Memory Layers

- `memory/current-task.md`: active task state
- `memory/YYYY-MM-DD.md`: daily notes
- `memory/preferences.json`: stable preferences
- `memory/facts.json`: durable facts
- `MEMORY.md`: curated long-term memory for private main sessions only

## Long Task Shape

For multi-turn tasks, keep:

- Goal
- Current stage
- Done
- Blockers
- Next step
- Key files
- Verification status
