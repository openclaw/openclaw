---
name: memoria-recovery
description: |
  Recover from wrong memory state using Memoria list/forget/store/stat workflows.
  Triggers: "restore memory", "undo memory change", "memory is wrong", "rebuild memory facts".
---

# Memoria Recovery

Use Memoria tools to repair memory quality when data is stale, wrong, or over-broad.

## Recovery flow

1. Inspect current memory state with `memory_list` and `memory_stats`.
2. Identify incorrect entries with `memory_search` or `memory_recall`.
3. Remove wrong entries with `memory_forget`.
4. Re-store corrected facts with `memory_store`.
5. Verify with `memory_recall` and `memory_stats`.

## Rules

- Prefer targeted repair over broad deletion.
- If multiple candidates are returned, ask for confirmation before deleting by id.
- After repair, summarize what changed and what was verified.
