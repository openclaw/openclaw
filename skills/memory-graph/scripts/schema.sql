-- Tommy's Memory Graph — SQLite with JSON1 extension
-- Replaces MEMORY.md markdown nodes with queryable graph

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Core node table
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,              -- A001, T003, D042, etc.
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,           -- The full prose memory
    
    -- Conway/Damasio/Rathbone metadata
    type TEXT NOT NULL CHECK(type IN ('episodic','semantic','procedural','relational')),
    tier TEXT NOT NULL CHECK(tier IN ('anchor','transition','context','detail')),
    weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10),
    reinforcement INTEGER NOT NULL DEFAULT 1,
    epoch TEXT NOT NULL,               -- 'founding' or YYYY-MM
    narrative_role TEXT NOT NULL CHECK(narrative_role IN ('anchor','transition','context','detail')),
    
    -- Metadata
    tags TEXT NOT NULL DEFAULT '[]',   -- JSON array
    created_at TEXT NOT NULL DEFAULT (date('now')),
    last_accessed TEXT NOT NULL DEFAULT (date('now')),
    updated_at TEXT NOT NULL DEFAULT (date('now')),
    
    -- Search optimization
    search_text TEXT GENERATED ALWAYS AS (title || ' ' || narrative || ' ' || tags) STORED
);

-- Typed edges between nodes
CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK(relation IN (
        'led_to',       -- causal: X caused/enabled Y
        'contradicts',  -- tension: X conflicts with Y
        'supports',     -- reinforcement: X provides evidence for Y
        'part_of',      -- containment: X is a component of Y
        'taught_by',    -- correction: X was a lesson from Y
        'deepens',      -- elaboration: X adds depth to Y
        'evolved_to',   -- temporal: X became Y over time
        'references'    -- generic cross-reference
    )),
    context TEXT,        -- Optional: why this edge exists
    created_at TEXT NOT NULL DEFAULT (date('now')),
    PRIMARY KEY (source_id, target_id, relation)
);

-- Self-model (singleton — the "who am I" narrative)
CREATE TABLE IF NOT EXISTS self_model (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    narrative TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (date('now'))
);

-- Synthesis log (replaces the footer in MEMORY.md)
CREATE TABLE IF NOT EXISTS synthesis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    summary TEXT NOT NULL,
    nodes_added TEXT DEFAULT '[]',    -- JSON array of IDs
    nodes_updated TEXT DEFAULT '[]',
    nodes_removed TEXT DEFAULT '[]',
    edges_added INTEGER DEFAULT 0
);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id, title, narrative, tags,
    content=nodes,
    content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, title, narrative, tags)
    VALUES (new.rowid, new.id, new.title, new.narrative, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, title, narrative, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.narrative, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, title, narrative, tags)
    VALUES ('delete', old.rowid, old.id, old.title, old.narrative, old.tags);
    INSERT INTO nodes_fts(rowid, id, title, narrative, tags)
    VALUES (new.rowid, new.id, new.title, new.narrative, new.tags);
END;

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);
CREATE INDEX IF NOT EXISTS idx_nodes_weight ON nodes(weight DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_last_accessed ON nodes(last_accessed);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
