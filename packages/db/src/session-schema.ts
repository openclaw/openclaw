/**
 * Session Intelligence FTS5 schema.
 * Moved from extensions/mabos/extensions-mabos/src/session-intel/session-index.ts
 */
export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS indexed_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT 'default',
  source TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  title TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS indexed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES indexed_sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_name TEXT,
  timestamp REAL NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content=indexed_messages,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON indexed_messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON indexed_messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE INDEX IF NOT EXISTS idx_messages_session ON indexed_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON indexed_sessions(agent_id);
`;
