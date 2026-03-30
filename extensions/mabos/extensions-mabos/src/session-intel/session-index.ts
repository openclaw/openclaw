import Database from "better-sqlite3";
import type { IndexedSession, IndexedMessage } from "./types.js";

const SCHEMA = `
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

export class SessionIndex {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  indexSession(session: IndexedSession): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO indexed_sessions (id, agent_id, company_id, source, started_at, ended_at, message_count, title, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        session.id,
        session.agentId,
        session.companyId,
        session.source,
        session.startedAt,
        session.endedAt,
        session.messageCount,
        session.title,
        session.summary,
      );
  }

  indexMessage(msg: Omit<IndexedMessage, "id">): void {
    this.db
      .prepare(
        `
      INSERT INTO indexed_messages (session_id, role, content, tool_name, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(msg.sessionId, msg.role, msg.content, msg.toolName, msg.timestamp);
  }

  search(
    query: string,
    opts?: { agentId?: string; companyId?: string; limit?: number },
  ): Array<{
    content: string;
    role: string;
    toolName: string | null;
    timestamp: number;
    sessionId: string;
    sessionTitle: string | null;
    agentId: string;
    relevance: number;
  }> {
    const limit = opts?.limit ?? 20;
    const conditions: string[] = [];
    const binds: unknown[] = [query];

    if (opts?.agentId) {
      conditions.push("s.agent_id = ?");
      binds.push(opts.agentId);
    }
    if (opts?.companyId) {
      conditions.push("s.company_id = ?");
      binds.push(opts.companyId);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    return this.db
      .prepare(
        `
      SELECT m.content, m.role, m.tool_name AS toolName, m.timestamp,
             s.id AS sessionId, s.title AS sessionTitle, s.agent_id AS agentId,
             rank AS relevance
      FROM messages_fts f
      JOIN indexed_messages m ON m.id = f.rowid
      JOIN indexed_sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ? ${where}
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(...binds, limit) as Array<{
      content: string;
      role: string;
      toolName: string | null;
      timestamp: number;
      sessionId: string;
      sessionTitle: string | null;
      agentId: string;
      relevance: number;
    }>;
  }

  getSessionCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) as count FROM indexed_sessions").get() as { count: number }
    ).count;
  }

  getMessageCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) as count FROM indexed_messages").get() as { count: number }
    ).count;
  }

  close(): void {
    this.db.close();
  }
}
