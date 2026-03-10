import type { SqliteRepository, PreparedStatement } from "./sqlite-repository.js";

// Stored detection row from SQLite (window_message_ids parsed from JSON)
export type StoredDetection = {
  id: number;
  conversation_id: string;
  detection_type: string;
  window_message_ids: number[];
  created: boolean;
  created_at: number;
};

export type DetectionRepository = {
  /** Insert a new detection and return the created row */
  insertDetection: (params: {
    conversationId: string;
    detectionType: string;
    windowMessageIds: number[];
  }) => StoredDetection;
  /** Get the most recent detection for a conversation, or null */
  getLastDetection: (conversationId: string) => StoredDetection | null;
  /** Mark a detection as created by id */
  markCreated: (id: number) => void;
  /** Delete a detection by id (used for rollback on agent send failure) */
  deleteDetection: (id: number) => void;
};

// Raw row shape from SQLite (window_message_ids is a JSON string, created is 0/1)
type DetectionRow = {
  id: number;
  conversation_id: string;
  detection_type: string;
  window_message_ids: string;
  created: number;
  created_at: number;
};

/**
 * Detection persistence layer.
 * Owns the detections table schema and INSERT/SELECT/UPDATE SQL.
 * Window message IDs are stored as JSON arrays in SQLite TEXT columns.
 */
export class DetectionRepositoryImpl implements DetectionRepository {
  private readonly insertStmt: PreparedStatement;
  private readonly queryStmt: PreparedStatement;
  private readonly markCreatedStmt: PreparedStatement;
  private readonly deleteStmt: PreparedStatement;

  constructor(db: SqliteRepository) {
    // Create schema (if it doesn't exist)
    db.exec(`
      CREATE TABLE IF NOT EXISTS detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        detection_type TEXT NOT NULL,
        window_message_ids TEXT NOT NULL,
        created INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_det_conv ON detections (conversation_id, created_at DESC);
    `);

    // Prepared statements
    this.insertStmt = db.prepare(`
      INSERT INTO detections (conversation_id, detection_type, window_message_ids, created, created_at)
      VALUES (?, ?, ?, 0, ?)
    `);

    // Order by id DESC — autoincrement guarantees insertion order even when
    // created_at timestamps collide (same ms)
    this.queryStmt = db.prepare(`
      SELECT id, conversation_id, detection_type, window_message_ids, created, created_at
      FROM detections
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);

    this.markCreatedStmt = db.prepare(`
      UPDATE detections SET created = 1 WHERE id = ?
    `);

    this.deleteStmt = db.prepare(`
      DELETE FROM detections WHERE id = ?
    `);
  }

  insertDetection(params: {
    conversationId: string;
    detectionType: string;
    windowMessageIds: number[];
  }): StoredDetection {
    this.insertStmt.run(
      params.conversationId,
      params.detectionType,
      JSON.stringify(params.windowMessageIds),
      Date.now(),
    );
    // Just inserted — guaranteed to exist
    return this.getLastDetection(params.conversationId)!;
  }

  getLastDetection(conversationId: string): StoredDetection | null {
    const rows = this.queryStmt.all(conversationId) as DetectionRow[];
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      detection_type: row.detection_type,
      window_message_ids: JSON.parse(row.window_message_ids) as number[],
      created: Boolean(row.created),
      created_at: row.created_at,
    };
  }

  markCreated(id: number): void {
    this.markCreatedStmt.run(id);
  }

  deleteDetection(id: number): void {
    this.deleteStmt.run(id);
  }
}
