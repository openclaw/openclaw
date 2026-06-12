# Fix: WAL checkpoint after writeMeta + stale index file cleanup

## Summary

Two hardening fixes for the memory-core atomic reindex pipeline, addressing the persistent "index metadata is missing" bug family (#90361, #90650, #91497, #92187).

## Problem

When the gateway process is killed during or shortly after `runSafeReindex`, two things can go wrong:

### 1. Meta row trapped in WAL

`writeMeta()` writes the `memory_index_meta_v1` row to the SQLite WAL (write-ahead log). The WAL is normally checkpointed when `closeMemoryDatabase()` is called. But if the process dies between `writeMeta()` and the close call, the meta row exists only in the WAL file. On the next startup, if the WAL is not properly replayed (e.g., the temp DB was being swapped), the manager reads no meta and declares the index "missing" — even though chunks are still present.

This puts the system into a permanent degraded state: `memory_search` returns `[]`, normal syncs hit an early return without fixing anything, and the only recovery is a manual `openclaw memory index --force`.

### 2. Stale backup/temp files accumulate

`runMemoryAtomicReindex` uses a rename-swap protocol that creates `.backup-{uuid}` and `.tmp-{uuid}` files. If the process is interrupted mid-swap, these files are never cleaned up. Over multiple interrupted reindexes, they accumulate in the memory directory.

## Fix

### `writeMeta` — force WAL checkpoint (defense in depth)

After writing the meta row, immediately run `PRAGMA wal_checkpoint(TRUNCATE)`. This forces all WAL data to be flushed to the main database file, so the meta row survives even if the process is killed before `closeMemoryDatabase`.

### `cleanupStaleIndexFiles` — housekeeping during sync

New helper called at the start of every `runSync()`. Scans the memory DB directory for `.backup-*` and `.tmp-*` files and removes them. Best-effort: if a file is locked (common on Windows), it's silently skipped and retried on the next sync.

## Related issues

- #90361 — Canonical bug: intermittent "index metadata is missing"
- #90650 — CLI works but agent tool fails
- #91497 — Meta not written during --force reindex
- #92187 — OOM during rebuild leaves empty DB

The primary fix for auto-recovery (`needsMissingIdentityReindex`) is already on main. This PR adds the remaining hardening layers to prevent meta loss in the first place and clean up after interrupted swaps.

## Testing

- New test: `manager.wal-checkpoint.test.ts` — verifies meta is readable from a fresh read-only connection after sync (WAL was checkpointed), and stale files are cleaned up
- Existing self-heal tests continue to pass

🤖 Generated with [Claude Code](https://claude.ai/code)
