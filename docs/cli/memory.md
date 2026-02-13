---
summary: "CLI reference for `openclaw memory` (status/index/search/rollup)"
read_when:
  - You want to index or search semantic memory
  - You're debugging memory availability or indexing
  - You want to set up continuity rollups
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing, search, and continuity rollups.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
# Memory indexing and search
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose

# Continuity rollups
openclaw memory rollup install               # Install hourly distiller cron job (main agent)
openclaw memory rollup install --every 30m   # Custom interval
openclaw memory rollup install --agent reviewer  # Install for a specific agent
openclaw memory rollup run                   # Run distiller now (main agent)
openclaw memory rollup run --agent reviewer  # Run for a specific agent
openclaw memory rollup show             # View current rollup
openclaw memory rollup path             # Print rollup file path
openclaw memory rollup clear            # Delete rollup file
openclaw memory rollup remove           # Remove the cron job
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

Rollup-specific:

- `--every <duration>`: run interval for the distiller (e.g., `30m`, `1h`, `2h`). Default: `1h`.
- `--model <model>`: model override for the distiller agent.
- `--thinking <level>`: thinking level (`off|minimal|low|medium|high`). Default: `off`.
- `--job-timeout-seconds <n>`: distiller job timeout in seconds. Default: `180`.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.

## Continuity Rollups

The rollup system provides **session continuity** by periodically distilling important context from memory into a compact `ROLLUP.md` file that is automatically injected into non-group sessions.

### How it works

1. **Install**: `openclaw memory rollup install [--agent <id>]` creates a cron job that runs hourly
2. **Distill**: The job uses `memory_search` to find recent decisions, todos, and context
3. **Write**: Results are written to `~/.openclaw/agents/<agent>/continuity/ROLLUP.md`
4. **Inject**: On each session start, the rollup content is included in the system prompt

### Security

- Rollups are **not** injected into group/channel sessions (privacy protection)
- Rollups are **not** injected into subagent sessions (minimal context)
- Only direct/DM sessions receive rollup injection

### Rollup format

```markdown
# Continuity Rollup

Updated: 2026-02-09T18:00:00Z

## Active Context

- Working on memory distillation feature
- Council dashboard improvements in progress

## Recent Decisions

- 2026-02-09: Use hourly distillation with top-of-hour alignment
- 2026-02-08: Skip rollup injection for group sessions

## Pending Actions

- [ ] Implement action queue from wiki pages
- [ ] Review idea-wiki capture pipeline
```
