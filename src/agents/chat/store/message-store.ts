/**
 * Message store for multi-agent chat system.
 * Handles CRUD operations for messages using PostgreSQL + TimescaleDB + Redis.
 */

import type {
  ChannelMessage,
  CreateMessageParams,
  MessageQuery,
  MessageReaction,
  MessageSearchParams,
  MessageSearchResult,
  UpdateMessageParams,
} from "../types/messages.js";
import {
  getChatDbClient,
  REDIS_KEYS,
  REDIS_TTL,
  fromJsonb,
  fromTimestamp,
  toJsonb,
} from "../db/client.js";
import { extractMentions, generateMessageId } from "../types/messages.js";

// Database row type
type MessageRow = {
  id: string;
  channel_id: string;
  author_id: string;
  author_type: string;
  author_name: string | null;
  content: string;
  content_blocks: string | null;
  thread_id: string | null;
  parent_message_id: string | null;
  mentions: string | null;
  reactions: string | null;
  created_at: Date;
  updated_at: Date | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  seq: string; // bigint comes as string
  metadata: string | null;
  external_source_id: string | null;
  external_platform: string | null;
};

// Transform function
function rowToMessage(row: MessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorType: row.author_type as ChannelMessage["authorType"],
    authorName: row.author_name ?? undefined,
    content: row.content,
    contentBlocks: fromJsonb(row.content_blocks) ?? undefined,
    threadId: row.thread_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    mentions: fromJsonb(row.mentions) ?? undefined,
    reactions: fromJsonb(row.reactions) ?? undefined,
    createdAt: fromTimestamp(row.created_at) ?? Date.now(),
    updatedAt: fromTimestamp(row.updated_at) ?? undefined,
    editedAt: fromTimestamp(row.edited_at) ?? undefined,
    deletedAt: fromTimestamp(row.deleted_at) ?? undefined,
    seq: Number.parseInt(row.seq, 10),
    metadata: fromJsonb(row.metadata) ?? undefined,
    externalSourceId: row.external_source_id ?? undefined,
    externalPlatform: row.external_platform ?? undefined,
  };
}

// Message operations
export async function createMessage(params: CreateMessageParams): Promise<ChannelMessage> {
  const db = getChatDbClient();
  const id = generateMessageId();
  const now = new Date();

  // Extract mentions from content
  const mentions = extractMentions(params.content);

  // Get next sequence number atomically using Redis
  const seqKey = REDIS_KEYS.messageSeq(params.channelId);
  const seq = await db.incr(seqKey);

  await db.execute(
    `INSERT INTO channel_messages (
      id, channel_id, author_id, author_type, author_name, content, content_blocks,
      thread_id, parent_message_id, mentions, reactions, created_at, seq, metadata,
      external_source_id, external_platform
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id,
      params.channelId,
      params.authorId,
      params.authorType,
      params.authorName ?? null,
      params.content,
      params.contentBlocks ? toJsonb(params.contentBlocks) : null,
      params.threadId ?? null,
      params.parentMessageId ?? null,
      mentions.length > 0 ? toJsonb(mentions) : null,
      "[]", // Empty reactions initially
      now,
      seq,
      params.metadata ? toJsonb(params.metadata) : null,
      params.externalSourceId ?? null,
      params.externalPlatform ?? null,
    ],
  );

  const message: ChannelMessage = {
    id,
    channelId: params.channelId,
    authorId: params.authorId,
    authorType: params.authorType,
    authorName: params.authorName,
    content: params.content,
    contentBlocks: params.contentBlocks,
    threadId: params.threadId,
    parentMessageId: params.parentMessageId,
    mentions: mentions.length > 0 ? mentions : undefined,
    reactions: [],
    createdAt: now.getTime(),
    seq,
    metadata: params.metadata,
    externalSourceId: params.externalSourceId,
    externalPlatform: params.externalPlatform,
  };

  // Add to recent messages cache
  await cacheRecentMessage(params.channelId, message);

  return message;
}

export async function getMessage(messageId: string): Promise<ChannelMessage | null> {
  const db = getChatDbClient();

  const row = await db.queryOne<MessageRow>(`SELECT * FROM channel_messages WHERE id = $1`, [
    messageId,
  ]);

  return row ? rowToMessage(row) : null;
}

export async function updateMessage(
  messageId: string,
  params: UpdateMessageParams,
): Promise<ChannelMessage | null> {
  const db = getChatDbClient();
  const now = new Date();

  const updates: string[] = ["updated_at = $1", "edited_at = $1"];
  const values: unknown[] = [now];
  let paramIndex = 2;

  if (params.content !== undefined) {
    updates.push(`content = $${paramIndex++}`);
    values.push(params.content);

    // Re-extract mentions
    const mentions = extractMentions(params.content);
    updates.push(`mentions = $${paramIndex++}`);
    values.push(mentions.length > 0 ? toJsonb(mentions) : null);
  }

  if (params.contentBlocks !== undefined) {
    updates.push(`content_blocks = $${paramIndex++}`);
    values.push(params.contentBlocks ? toJsonb(params.contentBlocks) : null);
  }

  if (params.metadata !== undefined) {
    updates.push(`metadata = metadata || $${paramIndex++}::jsonb`);
    values.push(toJsonb(params.metadata));
  }

  values.push(messageId);
  await db.execute(
    `UPDATE channel_messages SET ${updates.join(", ")} WHERE id = $${paramIndex}`,
    values,
  );

  return getMessage(messageId);
}

export async function deleteMessage(messageId: string, soft = true): Promise<boolean> {
  const db = getChatDbClient();

  if (soft) {
    const result = await db.execute(
      `UPDATE channel_messages SET deleted_at = NOW() WHERE id = $1`,
      [messageId],
    );
    return result.rowCount > 0;
  }

  const result = await db.execute(`DELETE FROM channel_messages WHERE id = $1`, [messageId]);
  return result.rowCount > 0;
}

export async function getMessages(query: MessageQuery): Promise<ChannelMessage[]> {
  const db = getChatDbClient();

  const conditions: string[] = ["channel_id = $1"];
  const values: unknown[] = [query.channelId];
  let paramIndex = 2;

  if (query.threadId !== undefined) {
    conditions.push(`thread_id = $${paramIndex++}`);
    values.push(query.threadId);
  } else {
    // By default, get only top-level messages (not in threads)
    conditions.push(`thread_id IS NULL`);
  }

  if (!query.includeDeleted) {
    conditions.push(`deleted_at IS NULL`);
  }

  if (query.beforeSeq !== undefined) {
    conditions.push(`seq < $${paramIndex++}`);
    values.push(query.beforeSeq);
  }

  if (query.afterSeq !== undefined) {
    conditions.push(`seq > $${paramIndex++}`);
    values.push(query.afterSeq);
  }

  if (query.authorId !== undefined) {
    conditions.push(`author_id = $${paramIndex++}`);
    values.push(query.authorId);
  }

  if (query.authorType !== undefined) {
    conditions.push(`author_type = $${paramIndex++}`);
    values.push(query.authorType);
  }

  const limit = query.limit ?? 50;
  values.push(limit);

  const whereClause = conditions.join(" AND ");

  const rows = await db.query<MessageRow>(
    `SELECT * FROM channel_messages WHERE ${whereClause} ORDER BY seq DESC LIMIT $${paramIndex}`,
    values,
  );

  // Return in chronological order
  return rows.map(rowToMessage).toReversed();
}

export async function getRecentMessages(channelId: string, limit = 50): Promise<ChannelMessage[]> {
  const db = getChatDbClient();

  // Try cache first
  const cacheKey = REDIS_KEYS.messageCache(channelId);
  const cached = await db.lrange(cacheKey, 0, limit - 1);

  if (cached.length > 0) {
    return cached
      .map((json) => fromJsonb<ChannelMessage>(json))
      .filter((m): m is ChannelMessage => m !== null);
  }

  // Query from database
  return getMessages({ channelId, limit });
}

export async function getThreadMessages(
  channelId: string,
  threadId: string,
  limit = 100,
): Promise<ChannelMessage[]> {
  return getMessages({
    channelId,
    threadId,
    limit,
  });
}

// Reactions
export async function addReaction(
  messageId: string,
  emoji: string,
  reactedBy: string,
): Promise<ChannelMessage | null> {
  const db = getChatDbClient();

  // Update reactions using JSONB operations
  await db.execute(
    `UPDATE channel_messages
     SET reactions = (
       SELECT COALESCE(
         jsonb_agg(
           CASE
             WHEN r->>'emoji' = $2 THEN
               jsonb_set(r, '{count}', to_jsonb((r->>'count')::int + 1))
               || jsonb_build_object('reactedBy', (r->'reactedBy') || to_jsonb($3::text))
             ELSE r
           END
         ),
         '[]'::jsonb
       )
       || CASE
         WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(reactions) r WHERE r->>'emoji' = $2)
         THEN jsonb_build_array(jsonb_build_object('emoji', $2, 'count', 1, 'reactedBy', jsonb_build_array($3)))
         ELSE '[]'::jsonb
       END
       FROM jsonb_array_elements(COALESCE(reactions, '[]'::jsonb)) r
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [messageId, emoji, reactedBy],
  );

  return getMessage(messageId);
}

export async function removeReaction(
  messageId: string,
  emoji: string,
  reactedBy: string,
): Promise<ChannelMessage | null> {
  const db = getChatDbClient();

  // Remove reaction using JSONB operations
  await db.execute(
    `UPDATE channel_messages
     SET reactions = (
       SELECT COALESCE(
         jsonb_agg(
           CASE
             WHEN r->>'emoji' = $2 AND (r->>'count')::int > 1 THEN
               jsonb_set(
                 jsonb_set(r, '{count}', to_jsonb((r->>'count')::int - 1)),
                 '{reactedBy}',
                 (SELECT jsonb_agg(elem) FROM jsonb_array_elements(r->'reactedBy') elem WHERE elem::text != to_jsonb($3)::text)
               )
             WHEN r->>'emoji' != $2 THEN r
           END
         ) FILTER (WHERE
           r->>'emoji' != $2 OR (r->>'count')::int > 1
         ),
         '[]'::jsonb
       )
       FROM jsonb_array_elements(COALESCE(reactions, '[]'::jsonb)) r
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [messageId, emoji, reactedBy],
  );

  return getMessage(messageId);
}

export async function getReactions(messageId: string): Promise<MessageReaction[]> {
  const message = await getMessage(messageId);
  return message?.reactions ?? [];
}

// Search
export async function searchMessages(params: MessageSearchParams): Promise<MessageSearchResult[]> {
  const db = getChatDbClient();

  const conditions: string[] = [
    `deleted_at IS NULL`,
    `to_tsvector('english', content) @@ plainto_tsquery('english', $1)`,
  ];
  const values: unknown[] = [params.query];
  let paramIndex = 2;

  if (params.channelIds && params.channelIds.length > 0) {
    conditions.push(`channel_id = ANY($${paramIndex++})`);
    values.push(params.channelIds);
  }

  if (params.authorId) {
    conditions.push(`author_id = $${paramIndex++}`);
    values.push(params.authorId);
  }

  if (params.beforeDate) {
    conditions.push(`created_at < $${paramIndex++}`);
    values.push(new Date(params.beforeDate));
  }

  if (params.afterDate) {
    conditions.push(`created_at > $${paramIndex++}`);
    values.push(new Date(params.afterDate));
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  values.push(limit, offset);

  const whereClause = conditions.join(" AND ");

  const rows = await db.query<MessageRow & { rank: number }>(
    `SELECT *,
       ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) as rank
     FROM channel_messages
     WHERE ${whereClause}
     ORDER BY rank DESC, created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    values,
  );

  return rows.map((row) => ({
    message: rowToMessage(row),
    highlights: extractHighlights(row.content, params.query),
    score: row.rank,
  }));
}

// Analytics - using TimescaleDB continuous aggregates
export async function getMessageStats(
  channelId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ bucket: Date; messageCount: number; uniqueAuthors: number }[]> {
  const db = getChatDbClient();

  const rows = await db.query<{
    bucket: Date;
    message_count: string;
    unique_authors: string;
  }>(
    `SELECT bucket, message_count, unique_authors
     FROM channel_message_stats_hourly
     WHERE channel_id = $1 AND bucket >= $2 AND bucket < $3
     ORDER BY bucket`,
    [channelId, startDate, endDate],
  );

  return rows.map((row) => ({
    bucket: new Date(row.bucket),
    messageCount: Number.parseInt(row.message_count, 10),
    uniqueAuthors: Number.parseInt(row.unique_authors, 10),
  }));
}

// Read receipts
export async function updateReadReceipt(
  channelId: string,
  agentId: string,
  seq: number,
): Promise<void> {
  const db = getChatDbClient();

  await db.execute(
    `INSERT INTO message_read_receipts (channel_id, agent_id, last_read_seq, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (channel_id, agent_id) DO UPDATE
     SET last_read_seq = GREATEST(message_read_receipts.last_read_seq, EXCLUDED.last_read_seq),
         last_read_at = NOW()`,
    [channelId, agentId, seq],
  );
}

export async function getUnreadCount(channelId: string, agentId: string): Promise<number> {
  const db = getChatDbClient();

  const result = await db.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM channel_messages m
     WHERE m.channel_id = $1
       AND m.deleted_at IS NULL
       AND m.seq > COALESCE(
         (SELECT last_read_seq FROM message_read_receipts WHERE channel_id = $1 AND agent_id = $2),
         0
       )`,
    [channelId, agentId],
  );

  return result ? Number.parseInt(result.count, 10) : 0;
}

export async function getUnreadCounts(agentId: string): Promise<Map<string, number>> {
  const db = getChatDbClient();

  const rows = await db.query<{ channel_id: string; unread: string }>(
    `SELECT m.channel_id, COUNT(*) as unread
     FROM channel_messages m
     JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.agent_id = $1
     LEFT JOIN message_read_receipts r ON r.channel_id = m.channel_id AND r.agent_id = $1
     WHERE m.deleted_at IS NULL
       AND m.seq > COALESCE(r.last_read_seq, 0)
     GROUP BY m.channel_id`,
    [agentId],
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.channel_id, Number.parseInt(row.unread, 10));
  }
  return counts;
}

// Helper functions
async function cacheRecentMessage(channelId: string, message: ChannelMessage): Promise<void> {
  const db = getChatDbClient();
  const cacheKey = REDIS_KEYS.messageCache(channelId);

  // Add to list and trim to keep only recent messages
  await db.lpush(cacheKey, toJsonb(message));
  await db.ltrim(cacheKey, 0, 99); // Keep last 100 messages
  await db.expire(cacheKey, REDIS_TTL.messageCache);
}

function extractHighlights(content: string, query: string): string[] {
  const highlights: string[] = [];
  const words = query.toLowerCase().split(/\s+/);
  const lines = content.split(/\n/);

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    for (const word of words) {
      if (lowerLine.includes(word)) {
        highlights.push(line.trim());
        break;
      }
    }
  }

  return highlights.slice(0, 3); // Return up to 3 highlights
}
