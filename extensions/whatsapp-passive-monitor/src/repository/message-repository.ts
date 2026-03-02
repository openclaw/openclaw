import type { StoredMessage } from "../types.js";
import type { SqliteRepository, PreparedStatement } from "./sqlite-repository.js";

export type MessageRepository = {
  /** Insert a message into the store */
  insertMessage: (msg: Omit<StoredMessage, "id">) => void;
  /** Get messages for a conversation, returned in chronological order (oldest first) */
  getConversation: (conversationId: string, options?: { limit?: number }) => StoredMessage[];
};

const DEFAULT_LIMIT = 50;

/**
 * Message persistence layer.
 * Owns the messages table schema, INSERT/SELECT SQL, and chronological ordering.
 */
export class MessageRepositoryImpl implements MessageRepository {
  private readonly sqliteRepository: SqliteRepository;
  private readonly insertStmt: PreparedStatement;
  private readonly queryStmt: PreparedStatement;

  constructor(db: SqliteRepository) {
    this.sqliteRepository = db;

    // Create schema (if it doesn't exist)
    this.sqliteRepository.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        channel_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_ts ON messages (conversation_id, timestamp DESC);
    `);

    // Prepared statements for performance
    this.insertStmt = this.sqliteRepository.prepare(`
      INSERT INTO messages (conversation_id, sender, sender_name, content, timestamp, direction, channel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Query: grab last N by timestamp DESC, then reverse to chronological
    this.queryStmt = this.sqliteRepository.prepare(`
      SELECT id, conversation_id, sender, sender_name, content, timestamp, direction, channel_id
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
  }

  insertMessage(msg: Omit<StoredMessage, "id">): void {
    this.insertStmt.run(
      msg.conversation_id,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.direction,
      msg.channel_id,
    );
  }

  getConversation(conversationId: string, options?: { limit?: number }): StoredMessage[] {
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const rows = this.queryStmt.all(conversationId, limit) as StoredMessage[];
    // Reverse from DESC to chronological order (oldest first)
    return rows.reverse();
  }
}
