---
summary: "Memory Debug UI for inspecting embedding database, chunks, and testing search"
title: "Memory Debug UI"
read_when:
  - You want to debug memory embedding index
  - You need to inspect chunks in SQLite database
  - You want to test semantic search queries
---

# Memory Debug UI 🧠

A web-based interface for debugging OpenClaw's memory embedding system.

## Access

Navigate to: **`/memory`** in your OpenClaw UI

Example: `http://localhost:3000/memory`

## Features

### 1. Status Dashboard

View real-time memory system status:

- **Chunks**: Total indexed chunks in database
- **Files Indexed**: Number of Markdown files processed
- **Cache Entries**: Cached embeddings count
- **Last Sync**: Time since last index sync
- **Provider Status**: Embedding provider health
- **Index Health**: Vector search and FTS availability

### 2. Chunks Browser

Inspect individual indexed chunks:

- File path
- Line range
- Text preview
- Content hash
- Embedding vector (optional)

### 3. Search Testing

Test semantic search queries:

- Enter natural language queries
- View ranked results with scores
- See vector vs BM25 contribution
- Check temporal decay impact

### 4. Configuration View

Review current memory settings:

- Chunking parameters (tokens, overlap)
- Sync settings (watch, debounce, interval)
- Feature flags (batch, cache, hybrid)
- Ranking options (MMR, temporal decay)

## Actions

### Refresh Status

Fetch latest memory status from gateway.

**Use when:** You want to see updated stats after changes.

### Force Sync

Trigger immediate index sync.

**Use when:**

- Files were modified outside watcher
- Index shows "dirty" status
- You want to ensure all changes are indexed

### List Chunks

Load up to 100 most recent chunks from database.

**Use when:** You want to inspect what's actually indexed.

### Clear Cache

Remove cached embeddings.

**Use when:**

- Switching embedding models
- Debugging cache issues
- Want to force re-embedding

### Reindex All

Full rebuild of memory index.

**Use when:**

- Changing embedding provider
- Index corruption suspected
- Major config changes

## Gateway API Methods

The UI calls these gateway methods:

| Method               | Description              |
| -------------------- | ------------------------ |
| `memory.status`      | Get memory system status |
| `memory.chunks.list` | List indexed chunks      |
| `memory.search`      | Perform semantic search  |
| `memory.sync`        | Trigger index sync       |
| `memory.cache.clear` | Clear embedding cache    |
| `memory.index`       | Rebuild index            |

## Typical Workflows

### Debug Missing Memory

1. Go to **Status** tab
2. Check "Last Sync" time
3. If old, click **Force Sync**
4. Go to **Chunks** tab
5. Click **List Chunks**
6. Verify your memory file appears

### Test Search Quality

1. Go to **Search** tab
2. Enter a query (e.g., "API authentication")
3. Review results and scores
4. Check if expected memories appear
5. Adjust query or check indexing if missing

### Verify Embedding Provider

1. Go to **Status** tab
2. Check "Embedding Provider" card
3. Verify:
   - Provider name (e.g., "gemini")
   - Model (e.g., "gemini-embedding-001")
   - API Key: OK
   - Available: Yes
4. If issues, check gateway logs

### Monitor Index Health

1. Go to **Status** tab
2. Check "Index Health" card
3. Verify:
   - Vector Search: OK (sqlite-vec loaded)
   - Full-Text Search: OK (FTS5 loaded)
   - Sync Status: Up to date (not dirty)

## Troubleshooting

### "Gateway Disconnected"

**Problem:** UI shows disconnected warning.

**Solution:**

1. Check gateway is running: `openclaw gateway status`
2. Verify gateway URL in settings
3. Reconnect if needed

### "No chunks found"

**Problem:** Chunks tab is empty.

**Possible causes:**

- No memory files exist yet
- Index not synced
- Wrong agent selected

**Solution:**

1. Ensure `MEMORY.md` or `memory/*.md` files exist
2. Click **Force Sync**
3. Check gateway logs for errors

### "Search failed"

**Problem:** Search returns error.

**Possible causes:**

- Embedding provider unavailable
- Index not initialized
- Database locked

**Solution:**

1. Check provider status in Status tab
2. Try **Reindex All**
3. Restart gateway if database locked

### "Provider Unavailable"

**Problem:** Embedding provider shows as unavailable.

**Possible causes:**

- Missing API key
- Network issue
- Invalid config

**Solution:**

1. Check API key in config
2. Verify network connectivity
3. Test with CLI: `openclaw memory status --deep`

## Config Requirements

Memory Debug UI requires:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        enabled: true, // Must be enabled
      },
    },
  },
}
```

## Related Documentation

- [Memory System](/concepts/memory)
- [CLI Reference](/cli/memory)
- [Configuration](/gateway/configuration-reference#memory)
- [Embedding Providers](/concepts/memory#vector-memory-search)

---

**Location:** `~/Documents/openclaw/ui-next/app/memory/page.tsx`  
**Navigation:** System → Memory Debug
