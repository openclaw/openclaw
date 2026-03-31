# SQLite-backed Session Store

## Problem

The flat `sessions.json` file causes severe performance issues at scale:
- File grows to 42MB+ with 1000+ sessions
- Every session operation requires reading/writing the entire file
- Results in 140%+ CPU usage and 6+ second response times
- JSON parsing/serialization becomes the bottleneck

Related issues: #58534 (perf), #57497 (Postgres request)

## Solution: Two-tier Architecture

### Hot Index (SQLite)
A lightweight SQLite database replaces `sessions.json` for metadata:

```
~/.openclaw/state/agents/{agentId}/sessions/sessions.sqlite
```

**Schema columns:**
- `session_key` (PRIMARY KEY) - session identifier
- `session_id` - UUID
- `updated_at`, `created_at` - timestamps (indexed)
- `channel`, `last_channel`, `last_to`, `last_account_id`, `last_thread_id` - routing
- `label`, `display_name`, `status` - display info
- `model`, `model_provider`, `total_tokens`, `input_tokens`, `output_tokens` - model state
- `message_count`, `archived` - metadata
- `entry_json` - full SessionEntry blob for complex fields

**Benefits:**
- O(1) session lookups instead of O(n) JSON parsing
- Incremental updates (no full file rewrites)
- Proper indexing for common query patterns
- WAL mode for concurrent read/write
- ~10x faster at 1000+ sessions

### Cold Storage (unchanged)
Existing `.jsonl` transcript files stay as-is:
- Per-session files, already efficient
- Only loaded on explicit `sessions_history` calls
- Never in the hot path

## Configuration

Add to `openclaw.json`:

```json
{
  "session": {
    "storeType": "sqlite"  // "json" (default) or "sqlite"
  }
}
```

## Migration

### Automatic (on first access)
When `storeType: "sqlite"` is set, existing `sessions.json` is automatically migrated to SQLite on first load.

### Manual (CLI)
```bash
# Preview migration
openclaw sessions migrate --dry-run

# Migrate default agent
openclaw sessions migrate

# Migrate all agents
openclaw sessions migrate --all-agents

# Check store info
openclaw sessions store-info
```

## Fallback Behavior

- If SQLite unavailable (Node < 22.5), falls back to JSON automatically
- If SQLite operations fail, falls back to JSON for that operation
- `sessions.json` is preserved during migration (not deleted)

## Files Changed

### New Files
- `src/config/sessions/store-sqlite.ts` - SQLite storage implementation
- `src/config/sessions/store-facade.ts` - Backend abstraction layer
- `src/commands/sessions-migrate.ts` - Migration command

### Modified Files
- `src/config/types.base.ts` - Added `SessionStoreType` and `storeType` config
- `src/config/sessions/store.ts` - Integrated facade for load/save
- `src/cli/program/register.status-health-sessions.ts` - CLI commands

## Performance Expectations

| Metric | JSON (1000 sessions) | SQLite |
|--------|---------------------|--------|
| Load time | ~800ms | ~15ms |
| Single update | ~800ms | ~5ms |
| List all | ~800ms | ~20ms |
| Memory | 42MB parsed | ~2MB |
| CPU (save) | 100%+ | <5% |

## Testing

```bash
# Run session store tests
pnpm test -- src/config/sessions/

# Type check
pnpm tsgo

# Lint
pnpm check
```

## Backward Compatibility

- Default is `storeType: "json"` for backward compatibility
- Existing `sessions.json` files continue to work
- Migration is opt-in via config or CLI command
- SQLite requires Node 22.5+ (built-in `node:sqlite`)
