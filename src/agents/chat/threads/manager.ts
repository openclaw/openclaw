/**
 * Thread manager for multi-agent chat system.
 * Handles thread creation, subscriptions, and message routing.
 */

import { getChatDbClient } from "../db/client.js";

export type ThreadNotificationLevel = "all" | "mentions" | "none";

export type ThreadSubscriber = {
  agentId: string;
  notificationLevel: ThreadNotificationLevel;
  subscribedAt: number;
  lastReadAt?: number;
};

export type AgentChannelThread = {
  threadId: string;
  channelId: string;
  parentMessageId: string;
  title?: string;
  messageCount: number;
  lastMessageAt?: number;
  createdAt: number;
  archived: boolean;
  subscribers: ThreadSubscriber[];
  activatedAgents: string[]; // Agents that have participated
};

export type CreateThreadParams = {
  channelId: string;
  parentMessageId: string;
  title?: string;
  creatorId: string;
};

export type ThreadRow = {
  thread_id: string;
  channel_id: string;
  parent_message_id: string;
  title: string | null;
  message_count: number;
  last_message_at: Date | null;
  created_at: Date;
  archived: boolean;
};

export type SubscriberRow = {
  thread_id: string;
  agent_id: string;
  notification_level: string;
  subscribed_at: Date;
  last_read_at: Date | null;
};

function generateThreadId(): string {
  return `thread_${crypto.randomUUID()}`;
}

function rowToThread(row: ThreadRow, subscribers: ThreadSubscriber[] = []): AgentChannelThread {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    parentMessageId: row.parent_message_id,
    title: row.title ?? undefined,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).getTime() : undefined,
    createdAt: new Date(row.created_at).getTime(),
    archived: row.archived,
    subscribers,
    activatedAgents: subscribers.map((s) => s.agentId),
  };
}

function rowToSubscriber(row: SubscriberRow): ThreadSubscriber {
  return {
    agentId: row.agent_id,
    notificationLevel: row.notification_level as ThreadNotificationLevel,
    subscribedAt: new Date(row.subscribed_at).getTime(),
    lastReadAt: row.last_read_at ? new Date(row.last_read_at).getTime() : undefined,
  };
}

/**
 * Create a new thread from a message.
 */
export async function createThread(params: CreateThreadParams): Promise<AgentChannelThread> {
  const db = getChatDbClient();
  const threadId = generateThreadId();
  const now = new Date();

  await db.execute(
    `INSERT INTO channel_threads (thread_id, channel_id, parent_message_id, title, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [threadId, params.channelId, params.parentMessageId, params.title ?? null, now],
  );

  // Subscribe the creator
  await subscribeToThread(threadId, params.creatorId, "all");

  return {
    threadId,
    channelId: params.channelId,
    parentMessageId: params.parentMessageId,
    title: params.title,
    messageCount: 0,
    createdAt: now.getTime(),
    archived: false,
    subscribers: [
      {
        agentId: params.creatorId,
        notificationLevel: "all",
        subscribedAt: now.getTime(),
      },
    ],
    activatedAgents: [params.creatorId],
  };
}

/**
 * Get a thread by ID.
 */
export async function getThread(threadId: string): Promise<AgentChannelThread | null> {
  const db = getChatDbClient();

  const row = await db.queryOne<ThreadRow>(`SELECT * FROM channel_threads WHERE thread_id = $1`, [
    threadId,
  ]);

  if (!row) {
    return null;
  }

  const subscriberRows = await db.query<SubscriberRow>(
    `SELECT * FROM thread_subscribers WHERE thread_id = $1`,
    [threadId],
  );

  const subscribers = subscriberRows.map(rowToSubscriber);
  return rowToThread(row, subscribers);
}

/**
 * Get thread by parent message ID.
 */
export async function getThreadByMessage(
  parentMessageId: string,
): Promise<AgentChannelThread | null> {
  const db = getChatDbClient();

  const row = await db.queryOne<ThreadRow>(
    `SELECT * FROM channel_threads WHERE parent_message_id = $1`,
    [parentMessageId],
  );

  if (!row) {
    return null;
  }

  const subscriberRows = await db.query<SubscriberRow>(
    `SELECT * FROM thread_subscribers WHERE thread_id = $1`,
    [row.thread_id],
  );

  const subscribers = subscriberRows.map(rowToSubscriber);
  return rowToThread(row, subscribers);
}

/**
 * List threads in a channel.
 */
export async function listThreads(
  channelId: string,
  options?: {
    archived?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<AgentChannelThread[]> {
  const db = getChatDbClient();

  const conditions: string[] = ["channel_id = $1"];
  const values: unknown[] = [channelId];
  let paramIndex = 2;

  if (options?.archived !== undefined) {
    conditions.push(`archived = $${paramIndex++}`);
    values.push(options.archived);
  }

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  values.push(limit, offset);

  const rows = await db.query<ThreadRow>(
    `SELECT * FROM channel_threads
     WHERE ${conditions.join(" AND ")}
     ORDER BY last_message_at DESC NULLS LAST
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    values,
  );

  // Fetch subscribers for each thread
  const threads: AgentChannelThread[] = [];
  for (const row of rows) {
    const subscriberRows = await db.query<SubscriberRow>(
      `SELECT * FROM thread_subscribers WHERE thread_id = $1`,
      [row.thread_id],
    );
    threads.push(rowToThread(row, subscriberRows.map(rowToSubscriber)));
  }

  return threads;
}

/**
 * Subscribe an agent to a thread.
 */
export async function subscribeToThread(
  threadId: string,
  agentId: string,
  notificationLevel: ThreadNotificationLevel = "all",
): Promise<void> {
  const db = getChatDbClient();

  await db.execute(
    `INSERT INTO thread_subscribers (thread_id, agent_id, notification_level, subscribed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (thread_id, agent_id) DO UPDATE SET
       notification_level = EXCLUDED.notification_level`,
    [threadId, agentId, notificationLevel],
  );
}

/**
 * Unsubscribe an agent from a thread.
 */
export async function unsubscribeFromThread(threadId: string, agentId: string): Promise<void> {
  const db = getChatDbClient();

  await db.execute(`DELETE FROM thread_subscribers WHERE thread_id = $1 AND agent_id = $2`, [
    threadId,
    agentId,
  ]);
}

/**
 * Update subscription notification level.
 */
export async function updateSubscription(
  threadId: string,
  agentId: string,
  notificationLevel: ThreadNotificationLevel,
): Promise<void> {
  const db = getChatDbClient();

  await db.execute(
    `UPDATE thread_subscribers SET notification_level = $1 WHERE thread_id = $2 AND agent_id = $3`,
    [notificationLevel, threadId, agentId],
  );
}

/**
 * Mark thread as read for an agent.
 */
export async function markThreadRead(threadId: string, agentId: string): Promise<void> {
  const db = getChatDbClient();

  await db.execute(
    `UPDATE thread_subscribers SET last_read_at = NOW() WHERE thread_id = $1 AND agent_id = $2`,
    [threadId, agentId],
  );
}

/**
 * Get unread count for a thread.
 */
export async function getThreadUnreadCount(threadId: string, agentId: string): Promise<number> {
  const db = getChatDbClient();

  const result = await db.queryOne<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM channel_messages m
     WHERE m.thread_id = $1
       AND m.deleted_at IS NULL
       AND m.created_at > COALESCE(
         (SELECT last_read_at FROM thread_subscribers WHERE thread_id = $1 AND agent_id = $2),
         '1970-01-01'::timestamptz
       )`,
    [threadId, agentId],
  );

  return result ? Number.parseInt(result.count, 10) : 0;
}

/**
 * Get threads with unread messages for an agent.
 */
export async function getUnreadThreads(
  agentId: string,
): Promise<{ thread: AgentChannelThread; unreadCount: number }[]> {
  const db = getChatDbClient();

  const rows = await db.query<ThreadRow & { unread_count: string }>(
    `SELECT t.*, COUNT(m.id) as unread_count
     FROM channel_threads t
     JOIN thread_subscribers s ON s.thread_id = t.thread_id AND s.agent_id = $1
     LEFT JOIN channel_messages m ON m.thread_id = t.thread_id
       AND m.deleted_at IS NULL
       AND m.created_at > COALESCE(s.last_read_at, '1970-01-01'::timestamptz)
     GROUP BY t.thread_id
     HAVING COUNT(m.id) > 0
     ORDER BY t.last_message_at DESC`,
    [agentId],
  );

  const results: { thread: AgentChannelThread; unreadCount: number }[] = [];
  for (const row of rows) {
    const subscriberRows = await db.query<SubscriberRow>(
      `SELECT * FROM thread_subscribers WHERE thread_id = $1`,
      [row.thread_id],
    );
    results.push({
      thread: rowToThread(row, subscriberRows.map(rowToSubscriber)),
      unreadCount: Number.parseInt(row.unread_count, 10),
    });
  }

  return results;
}

/**
 * Archive a thread.
 */
export async function archiveThread(threadId: string): Promise<void> {
  const db = getChatDbClient();

  await db.execute(`UPDATE channel_threads SET archived = TRUE WHERE thread_id = $1`, [threadId]);
}

/**
 * Unarchive a thread.
 */
export async function unarchiveThread(threadId: string): Promise<void> {
  const db = getChatDbClient();

  await db.execute(`UPDATE channel_threads SET archived = FALSE WHERE thread_id = $1`, [threadId]);
}

/**
 * Update thread title.
 */
export async function updateThreadTitle(threadId: string, title: string): Promise<void> {
  const db = getChatDbClient();

  await db.execute(`UPDATE channel_threads SET title = $1 WHERE thread_id = $2`, [title, threadId]);
}

/**
 * Get agents that should be notified about a thread message.
 */
export async function getThreadNotificationTargets(
  threadId: string,
  excludeAgentId?: string,
  isMentioned?: (agentId: string) => boolean,
): Promise<string[]> {
  const thread = await getThread(threadId);
  if (!thread) {
    return [];
  }

  const targets: string[] = [];

  for (const subscriber of thread.subscribers) {
    if (excludeAgentId && subscriber.agentId === excludeAgentId) {
      continue;
    }

    if (subscriber.notificationLevel === "none") {
      continue;
    }

    if (subscriber.notificationLevel === "mentions") {
      if (isMentioned && !isMentioned(subscriber.agentId)) {
        continue;
      }
    }

    targets.push(subscriber.agentId);
  }

  return targets;
}

/**
 * Automatically subscribe an agent when they reply to a thread.
 */
export async function autoSubscribeOnReply(threadId: string, agentId: string): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread) {
    return;
  }

  // Check if already subscribed
  const isSubscribed = thread.subscribers.some((s) => s.agentId === agentId);
  if (isSubscribed) {
    return;
  }

  // Auto-subscribe with "all" notifications
  await subscribeToThread(threadId, agentId, "all");
}
