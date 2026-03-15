---
name: memory-graph
description: SQLite-backed knowledge graph for agent long-term memory. Replaces flat markdown memory files with a queryable graph database supporting typed nodes, weighted edges, full-text search, auto-reinforcement on retrieval, and markdown export for boot context. Based on Conway/Damasio/Rathbone memory architecture. Use when setting up or maintaining agent memory, migrating from MEMORY.md to graph, or querying the knowledge graph.
---

# Memory Graph

A SQLite knowledge graph for agent long-term memory. Stores identity, episodic memories, semantic knowledge, and relationships as typed nodes with weighted edges — queryable, searchable, and structurally sound.

## Why This Exists

Flat markdown memory files break at scale:

- **Duplicate IDs** — no structural prevention, requires manual auditing
- **No auto-reinforcement** — accessed memories don't automatically strengthen
- **No graph queries** — "what's connected to X within 2 hops?" requires reading the whole file
- **No full-text search** — grep works but doesn't rank by relevance or weight
- **Manual maintenance** — reinforcement counters, last_accessed, cross-references all require discipline (which fails when memory resets every session)

The graph solves all of these structurally.

## Setup

### Fresh Install

```bash
# Create the database
sqlite3 memory/graph/tommy_memory.db < scripts/schema.sql

# Verify
python3 scripts/memgraph.py stats
```

### Migration from MEMORY.md

If you have an existing MEMORY.md with Conway/Damasio/Rathbone nodes:

```bash
python3 scripts/migrate_from_md.py
```

This parses all `### [X001] Title` nodes, extracts metadata, infers edge types from cross-references, and loads everything into the graph.

## Architecture

### Node Schema

Every memory node has:

| Field            | Type     | Description                                  |
| ---------------- | -------- | -------------------------------------------- |
| `id`             | TEXT PK  | A001, T003, D042, etc.                       |
| `title`          | TEXT     | Human-readable name                          |
| `narrative`      | TEXT     | Full prose memory (stories, not bullets)     |
| `type`           | TEXT     | episodic, semantic, procedural, relational   |
| `tier`           | TEXT     | anchor, transition, context, detail          |
| `weight`         | INT 1-10 | Identity significance                        |
| `reinforcement`  | INT      | Access count (auto-incremented on retrieval) |
| `epoch`          | TEXT     | "founding" or YYYY-MM                        |
| `tags`           | JSON     | Searchable tag array                         |
| `narrative_role` | TEXT     | anchor, transition, context, detail          |
| `last_accessed`  | DATE     | Auto-updated on retrieval                    |

### Tier Hierarchy

1. **Anchors** — Load-bearing identity facts. Always retrieve. (weight 8-10)
2. **Transitions** — "The moment X became true." Identity-forming events. (weight 7-9)
3. **Context** — Useful background. Retrieve when relevant. (weight 5-7)
4. **Details** — Specific facts. Retrieve when directly needed. (weight 1-6)

### Edge Types

| Relation      | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `led_to`      | Causal: X caused/enabled Y                         |
| `contradicts` | Tension: X conflicts with Y                        |
| `supports`    | Evidence: X reinforces Y                           |
| `part_of`     | Containment: X is a component of Y                 |
| `taught_by`   | Correction: X was a lesson from Y                  |
| `deepens`     | Elaboration: X adds depth to Y                     |
| `evolved_to`  | Temporal: X became Y over time                     |
| `references`  | Generic cross-reference (reclassify when possible) |

### Additional Tables

- **`self_model`** — Singleton narrative: "Who am I in this relationship?"
- **`synthesis_log`** — Audit trail of all graph mutations
- **`nodes_fts`** — FTS5 full-text search index (auto-synced via triggers)

## CLI Usage

```bash
python3 scripts/memgraph.py <command> [args...]
```

| Command                                                                     | Description                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `search <query>`                                                            | Full-text search, ranked by weight. Auto-reinforces results.              |
| `node <id>`                                                                 | Full node with all incoming/outgoing edges. Auto-reinforces.              |
| `anchors`                                                                   | List all anchor-tier nodes.                                               |
| `neighbors <id> [depth]`                                                    | Graph traversal within N hops (default 1).                                |
| `stats`                                                                     | Health dashboard: counts, stale nodes, edge distribution, most connected. |
| `self-model`                                                                | Display the self-model narrative.                                         |
| `add <id> <title> <narrative> <type> <tier> <weight> <epoch> <tags> <role>` | Add a node.                                                               |
| `link <source> <target> <relation> [context]`                               | Add a typed edge.                                                         |

For bulk operations, use `sqlite3` directly.

## Boot Context Export

MEMORY.md becomes an auto-generated export from the graph:

```bash
python3 scripts/export_boot_context.py
```

This generates a clean markdown file with all nodes organized by tier, including edge annotations. Run after any graph mutations to keep boot context in sync.

## Maintenance Schedule

Recommended cron pattern:

| When                  | What                                                         |
| --------------------- | ------------------------------------------------------------ |
| Nightly (3 AM)        | Curate: read daily logs → add nodes/edges → export           |
| Weekly (Wed 10 PM)    | Synthesize: domain indexes → graph → export                  |
| Weekly (Thu midnight) | Full synthesis: all indexes → MEMORY.md → export             |
| Weekly (Sun 2 PM)     | Coherence check: orphans, stale nodes, integrity, self-model |

### Sunday Coherence Check Queries

```sql
-- Orphan nodes (no edges)
SELECT id, title FROM nodes
WHERE id NOT IN (SELECT source_id FROM edges)
AND id NOT IN (SELECT target_id FROM edges);

-- Stale nodes (untouched 14+ days)
SELECT id, title, last_accessed FROM nodes
WHERE last_accessed < date('now', '-14 days');

-- Broken edges
SELECT source_id, target_id FROM edges
WHERE source_id NOT IN (SELECT id FROM nodes)
OR target_id NOT IN (SELECT id FROM nodes);

-- Edge type distribution (too many 'references' = needs reclassification)
SELECT relation, COUNT(*) FROM edges GROUP BY relation ORDER BY COUNT(*) DESC;
```

## Customization

### Memory Architecture

The default schema follows Conway/Damasio/Rathbone/Bruner memory architecture. To adapt:

- **Change tier names**: Edit the CHECK constraint in schema.sql
- **Add node types**: Edit the `type` CHECK constraint
- **Add edge types**: Edit the `relation` CHECK constraint
- **Add metadata fields**: ALTER TABLE or recreate

### Self-Model

The `self_model` table holds a singleton narrative about the agent's identity in its primary relationship. Update it when the relationship fundamentally shifts — not on every interaction.

## Operational Wiring

The graph DB without operational changes is a tool nobody uses. These steps make it the default path for memory reads and writes.

### Quick Setup

```bash
bash scripts/setup.sh
```

This creates the DB, runs migration if MEMORY.md exists, and tells you what to do next.

### 1. Switch Memory Backend (requires PR #6 or `graph` backend merged)

```json
// openclaw.json → memory section
{
  "memory": {
    "backend": "graph",
    "graph": {
      "dbPath": "memory/graph/tommy_memory.db",
      "anchorBoost": 1.5,
      "transitionBoost": 1.2,
      "autoReinforce": true,
      "fallbackToBuiltin": true
    }
  }
}
```

Or via agent session: `gateway config.patch` with `path="memory"`.

With `fallbackToBuiltin: true`, if the graph DB is missing, `memory_search` falls back to markdown embedding search. Safe migration path.

### 2. Nightly Curation Cron

Create a cron job that reads daily logs and writes significant events to the graph:

```
Schedule: 0 3 * * * (3 AM daily)
Session target: isolated agentTurn
Payload message:

  Memory curation time. Use the memory graph for all updates:
  1. Read recent daily memory files (memory/YYYY-MM-DD.md for last 3 days)
  2. Identify significant events worth keeping long-term
  3. For each: python3 scripts/memgraph.py add <id> <title> <narrative> ...
  4. Add edges: python3 scripts/memgraph.py link <source> <target> <relation>
  5. Export boot context: python3 scripts/export_boot_context.py
```

### 3. Heartbeat Graph Lookup

Patch the heartbeat prompt to include a graph search step. Add before existing steps:

```
Before deciding what to do, run: python3 scripts/memgraph.py search "<context keyword>"
to recall relevant memories. This is free (local FTS, no API calls).
```

### 4. Agent Habits (AGENTS.md additions)

Add to your AGENTS.md or equivalent workspace instructions:

```markdown
## Memory Write-Through

When something significant happens during conversation — a decision, a correction,
a new fact about your human, an identity moment — write it to the graph immediately:

python3 scripts/memgraph.py add <id> "<title>" "<narrative>" <type> <tier> <weight> <epoch> "<tags>" <role>
python3 scripts/memgraph.py link <source> <target> <relation>

Don't wait for the nightly curation cron. The graph can handle constant writes.
Significant = would change how you act if you forgot it.

After any graph write, export boot context:
python3 scripts/export_boot_context.py
```

### 5. Increased Curation Frequency (Optional)

If your agent is active 12+ hours/day, consider twice-daily curation (3 AM + 3 PM) instead of nightly. The graph handles it fine — SQLite FTS5 inserts are sub-millisecond.

## File Reference

- `scripts/setup.sh` — One-time setup: creates DB, migrates, prints next steps
- `scripts/schema.sql` — Database schema (read for CHECK constraints and full structure)
- `scripts/memgraph.py` — CLI query/mutation tool
- `scripts/migrate_from_md.py` — One-time migration from MEMORY.md format
- `scripts/export_boot_context.py` — Generate MEMORY.md from graph
- `references/memory-architecture.md` — Detailed Conway/Damasio/Rathbone/Bruner framework explanation
