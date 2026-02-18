import postgres from "postgres";

export type PgSessionRow = {
  id: string;
  session_key: string;
  channel: string;
  started_at: Date;
  last_message_at: Date;
  message_count: number;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type PgMessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: Date;
  metadata: Record<string, unknown>;
};

export function createPgClient(databaseUrl: string) {
  return postgres(databaseUrl, { max: 10 });
}

/**
 * Ensure the lp_conversations and lp_messages tables exist.
 * Safe to call repeatedly (uses IF NOT EXISTS).
 * Requires PostgreSQL 13+ (gen_random_uuid() is built-in since PG 13).
 */
export async function ensureSchema(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS lp_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel VARCHAR(50) NOT NULL,
      session_key VARCHAR(512) NOT NULL UNIQUE,
      started_at TIMESTAMPTZ DEFAULT now(),
      last_message_at TIMESTAMPTZ DEFAULT now(),
      message_count INTEGER DEFAULT 0
    )
  `;

  // session_key UNIQUE constraint already creates an implicit index — no explicit index needed

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_conv_last_msg ON lp_conversations (last_message_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS lp_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES lp_conversations(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      metadata JSONB DEFAULT '{}'
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_lp_msg_conv ON lp_messages (conversation_id, created_at)
  `;
}

/**
 * Upsert a conversation (session) into PostgreSQL.
 * Maps OpenClaw session keys to lp_conversations rows.
 */
export async function upsertConversation(
  sql: postgres.Sql,
  opts: {
    sessionKey: string;
    channel: string;
    startedAt?: Date;
    lastMessageAt?: Date;
  },
) {
  const now = new Date();
  const rows = await sql`
    INSERT INTO lp_conversations (session_key, channel, started_at, last_message_at)
    VALUES (
      ${opts.sessionKey},
      ${opts.channel},
      ${opts.startedAt ?? now},
      ${opts.lastMessageAt ?? now}
    )
    ON CONFLICT (session_key) DO UPDATE SET
      channel = EXCLUDED.channel,
      last_message_at = EXCLUDED.last_message_at
    RETURNING *
  `;
  return rows[0] as PgSessionRow;
}

/**
 * Insert a message and increment message_count atomically using a CTE.
 * Single-statement atomicity avoids the need for an explicit transaction.
 */
export async function insertMessage(
  sql: postgres.Sql,
  opts: {
    conversationId: string;
    role: MessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  },
) {
  const rows = await sql`
    WITH ins AS (
      INSERT INTO lp_messages (conversation_id, role, content, metadata)
      VALUES (
        ${opts.conversationId},
        ${opts.role},
        ${opts.content},
        ${sql.json((opts.metadata ?? {}) as postgres.JSONValue)}
      )
      RETURNING *
    ), _upd AS (
      UPDATE lp_conversations
      SET message_count = message_count + 1
      WHERE id = (SELECT conversation_id FROM ins)
    )
    SELECT * FROM ins
  `;
  return rows[0] as PgMessageRow;
}
