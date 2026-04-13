# @openclaw/lesson-engine

Offline maintenance CLI for the four OpenClaw agents' `lessons-learned.json` stores.

Ships four subcommands — **migrate**, **dedupe**, **forget**, **status** — plus a
`maintenance` meta-command intended for a daily cron.

## Scope (P0)

- Schema migration (adds `createdAt` / `severity` / `hitCount` / `appliedCount` /
  `lastHitAt` / `mergedFrom` / `duplicateOf` / `lifecycle`) — **does not mutate
  any pre-existing field**.
- TF-IDF cosine dedupe within a single agent's store (`cosine >= 0.6` ⇒ merge).
- Recency + usefulness + severity scored forgetting (`active ≤ 50` →
  tail becomes `stale`, stale older than 90 days becomes `archive`, never deleted).
- `maintenance-state.json` book-keeping under `~/AgentData/shared/lessons/`.

**Out of scope for P0**: error capture, LLM distillation, session-start
injection, or relocating the canonical store.

## Storage layout

```
~/AgentData/<agent>/memory/lessons-learned.json         # active store (per agent)
~/AgentData/<agent>/memory/lessons-learned.json.bak.*   # timestamped backup
~/AgentData/shared/lessons/maintenance-state.json       # global run state
```

`AGENT_DATA_ROOT` env var overrides `~/AgentData` for testing.

## Usage

```bash
cd extensions/lesson-engine
# dry-run migrate on a single agent
pnpm lesson-engine migrate --agent builder --dry-run

# apply migration (writes `.bak.<ts>` first, then atomically rewrites file)
pnpm lesson-engine migrate --agent builder --apply

# dedupe (dry-run by default)
pnpm lesson-engine dedupe --agent builder
pnpm lesson-engine dedupe --agent builder --apply

# forget pass
pnpm lesson-engine forget --agent builder --apply --max-active 50

# combined dedupe + forget + state bookkeeping
pnpm lesson-engine maintenance --all --apply

# report only
pnpm lesson-engine status --all
```

All subcommands print structured JSON to **stdout** (machine readable) and a
human summary to **stderr**. Exit codes: `0` success, `1` user error,
`2` runtime error.

## Cron

See `cron-example.json`. Human operator decides when to enable it — this
extension does not wire anything automatically.

```jsonc
{
  "id": "lesson-engine-maintenance",
  "schedule": { "kind": "cron", "expr": "0 4 * * *" },
  "target": "<agent>",
  "prompt": "lesson-engine maintenance --all --apply",
}
```

## Tests

```bash
cd extensions/lesson-engine
pnpm test   # or: npx vitest run
```

Tests use ephemeral fixtures under a temp `AGENT_DATA_ROOT` — they never touch
real agent memory.

## Safety invariants

1. Runtime code, any agent's `MEMORY.md`, `AGENTS.md`, `SOUL.md`,
   `IDENTITY.md`, and other extensions are **never** modified by this tool.
2. `migrate` writes a timestamped `.bak.<ISO>` before the atomic rename.
3. Existing lesson fields (`id`, `title`, `category`, `tags`, `date`,
   `context`, `mistake`, `lesson`, `fix`, `correction`, …) are preserved
   verbatim. Stray top-level keys in the store (e.g. architect's
   `lesson-probe-*`) are preserved too.
4. `forget` never deletes — worst case is `lifecycle = "archive"`.
