---
summary: "CLI reference for `smart-agent-neo memory` (status/index/search)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `smart-agent-neo memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
smart-agent-neo memory status
smart-agent-neo memory status --deep
smart-agent-neo memory status --deep --index
smart-agent-neo memory status --deep --index --verbose
smart-agent-neo memory index
smart-agent-neo memory index --verbose
smart-agent-neo memory search "release checklist"
smart-agent-neo memory status --agent main
smart-agent-neo memory index --agent main --verbose
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
