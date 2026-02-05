/**
 * Channel events for real-time WebSocket broadcasting.
 * Integrates with the existing gateway broadcast system.
 */

import type { CollaborationEvent } from "../collaboration/types.js";
import type { AgentPresence } from "../presence/manager.js";
import type { AgentChannelThread } from "../threads/manager.js";
import type { AgentChannel, AgentChannelMember } from "../types/channels.js";
import type { ChannelMessage } from "../types/messages.js";
import { getChatDbClient, REDIS_KEYS, toJsonb, fromJsonb } from "../db/client.js";

export type ChannelEventType =
  | "channel.message"
  | "channel.message.edit"
  | "channel.message.delete"
  | "channel.reaction.add"
  | "channel.reaction.remove"
  | "channel.typing"
  | "channel.presence"
  | "channel.member.join"
  | "channel.member.leave"
  | "channel.member.update"
  | "channel.update"
  | "channel.archive"
  | "channel.delete"
  | "thread.create"
  | "thread.update"
  | "thread.message"
  | "collaboration.event";

export type ChannelEvent =
  | { type: "channel.message"; channelId: string; message: ChannelMessage; threadId?: string }
  | {
      type: "channel.message.edit";
      channelId: string;
      messageId: string;
      content: string;
      editedAt: number;
    }
  | { type: "channel.message.delete"; channelId: string; messageId: string; deletedAt: number }
  | {
      type: "channel.reaction.add";
      channelId: string;
      messageId: string;
      emoji: string;
      agentId: string;
    }
  | {
      type: "channel.reaction.remove";
      channelId: string;
      messageId: string;
      emoji: string;
      agentId: string;
    }
  | {
      type: "channel.typing";
      channelId: string;
      agentId: string;
      started: boolean;
      threadId?: string;
    }
  | { type: "channel.presence"; channelId: string; presence: AgentPresence }
  | { type: "channel.member.join"; channelId: string; member: AgentChannelMember }
  | { type: "channel.member.leave"; channelId: string; agentId: string }
  | { type: "channel.member.update"; channelId: string; member: AgentChannelMember }
  | { type: "channel.update"; channelId: string; channel: Partial<AgentChannel> }
  | { type: "channel.archive"; channelId: string; archivedBy: string }
  | { type: "channel.delete"; channelId: string }
  | { type: "thread.create"; channelId: string; thread: AgentChannelThread }
  | {
      type: "thread.update";
      channelId: string;
      threadId: string;
      update: Partial<AgentChannelThread>;
    }
  | { type: "thread.message"; channelId: string; threadId: string; message: ChannelMessage }
  | { type: "collaboration.event"; channelId: string; event: CollaborationEvent };

export type EventPayload = {
  event: ChannelEvent;
  timestamp: number;
  channelId: string;
  senderId?: string;
};

// Local event listeners (in-process)
const localListeners = new Map<string, Set<(event: ChannelEvent) => void>>();
const globalListeners = new Set<(event: ChannelEvent) => void>();

/**
 * Emit a channel event.
 * Broadcasts to both Redis pub/sub and local listeners.
 */
export async function emitChannelEvent(event: ChannelEvent, senderId?: string): Promise<void> {
  const payload: EventPayload = {
    event,
    timestamp: Date.now(),
    channelId: event.channelId,
    senderId,
  };

  // Publish to Redis for cross-process/cross-server delivery
  try {
    const db = getChatDbClient();
    const channel = REDIS_KEYS.pubsubChannel(event.channelId);
    await db.publish(channel, toJsonb(payload));
  } catch {
    // Redis not available, continue with local delivery
  }

  // Notify local listeners
  notifyLocalListeners(event);
}

/**
 * Emit a global event (not channel-specific).
 */
export async function emitGlobalEvent(event: ChannelEvent, senderId?: string): Promise<void> {
  const payload: EventPayload = {
    event,
    timestamp: Date.now(),
    channelId: event.channelId,
    senderId,
  };

  try {
    const db = getChatDbClient();
    await db.publish(REDIS_KEYS.pubsubGlobal(), toJsonb(payload));
  } catch {
    // Redis not available
  }

  notifyGlobalListeners(event);
}

/**
 * Subscribe to events for a specific channel.
 */
export async function subscribeToChannel(
  channelId: string,
  handler: (event: ChannelEvent) => void,
): Promise<() => Promise<void>> {
  // Add to local listeners
  if (!localListeners.has(channelId)) {
    localListeners.set(channelId, new Set());
  }
  localListeners.get(channelId)!.add(handler);

  // Subscribe to Redis pub/sub
  try {
    const db = getChatDbClient();
    const channel = REDIS_KEYS.pubsubChannel(channelId);
    await db.subscribe(channel, (message) => {
      const payload = fromJsonb<EventPayload>(message);
      if (payload?.event) {
        handler(payload.event);
      }
    });
  } catch {
    // Redis not available
  }

  // Return unsubscribe function
  return async () => {
    localListeners.get(channelId)?.delete(handler);

    try {
      const db = getChatDbClient();
      await db.unsubscribe(REDIS_KEYS.pubsubChannel(channelId));
    } catch {
      // Ignore
    }
  };
}

/**
 * Subscribe to all channel events (global listener).
 */
export async function subscribeToAllChannels(
  handler: (event: ChannelEvent) => void,
): Promise<() => Promise<void>> {
  globalListeners.add(handler);

  try {
    const db = getChatDbClient();
    await db.psubscribe("pubsub:channel:*", (_channel, message) => {
      const payload = fromJsonb<EventPayload>(message);
      if (payload?.event) {
        handler(payload.event);
      }
    });
  } catch {
    // Redis not available
  }

  return async () => {
    globalListeners.delete(handler);

    try {
      const db = getChatDbClient();
      await db.punsubscribe("pubsub:channel:*");
    } catch {
      // Ignore
    }
  };
}

/**
 * Subscribe to events for a specific agent.
 */
export async function subscribeToAgentEvents(
  agentId: string,
  handler: (event: ChannelEvent) => void,
): Promise<() => Promise<void>> {
  try {
    const db = getChatDbClient();
    const channel = REDIS_KEYS.pubsubAgent(agentId);
    await db.subscribe(channel, (message) => {
      const payload = fromJsonb<EventPayload>(message);
      if (payload?.event) {
        handler(payload.event);
      }
    });
  } catch {
    // Redis not available
  }

  return async () => {
    try {
      const db = getChatDbClient();
      await db.unsubscribe(REDIS_KEYS.pubsubAgent(agentId));
    } catch {
      // Ignore
    }
  };
}

/**
 * Send an event to a specific agent.
 */
export async function sendToAgent(agentId: string, event: ChannelEvent): Promise<void> {
  const payload: EventPayload = {
    event,
    timestamp: Date.now(),
    channelId: event.channelId,
  };

  try {
    const db = getChatDbClient();
    await db.publish(REDIS_KEYS.pubsubAgent(agentId), toJsonb(payload));
  } catch {
    // Redis not available
  }
}

// Helper functions
function notifyLocalListeners(event: ChannelEvent): void {
  const listeners = localListeners.get(event.channelId);
  if (listeners) {
    for (const handler of listeners) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}

function notifyGlobalListeners(event: ChannelEvent): void {
  for (const handler of globalListeners) {
    try {
      handler(event);
    } catch {
      // Ignore handler errors
    }
  }
}

// Convenience functions for common events
export async function emitNewMessage(
  channelId: string,
  message: ChannelMessage,
  senderId?: string,
): Promise<void> {
  if (message.threadId) {
    await emitChannelEvent(
      { type: "thread.message", channelId, threadId: message.threadId, message },
      senderId,
    );
  } else {
    await emitChannelEvent({ type: "channel.message", channelId, message }, senderId);
  }
}

export async function emitMessageEdit(
  channelId: string,
  messageId: string,
  content: string,
): Promise<void> {
  await emitChannelEvent({
    type: "channel.message.edit",
    channelId,
    messageId,
    content,
    editedAt: Date.now(),
  });
}

export async function emitMessageDelete(channelId: string, messageId: string): Promise<void> {
  await emitChannelEvent({
    type: "channel.message.delete",
    channelId,
    messageId,
    deletedAt: Date.now(),
  });
}

export async function emitTyping(
  channelId: string,
  agentId: string,
  started: boolean,
  threadId?: string,
): Promise<void> {
  await emitChannelEvent({
    type: "channel.typing",
    channelId,
    agentId,
    started,
    threadId,
  });
}

export async function emitPresenceUpdate(
  channelId: string,
  presence: AgentPresence,
): Promise<void> {
  await emitChannelEvent({
    type: "channel.presence",
    channelId,
    presence,
  });
}

export async function emitMemberJoin(channelId: string, member: AgentChannelMember): Promise<void> {
  await emitChannelEvent({
    type: "channel.member.join",
    channelId,
    member,
  });
}

export async function emitMemberLeave(channelId: string, agentId: string): Promise<void> {
  await emitChannelEvent({
    type: "channel.member.leave",
    channelId,
    agentId,
  });
}

export async function emitChannelUpdate(
  channelId: string,
  update: Partial<AgentChannel>,
): Promise<void> {
  await emitChannelEvent({
    type: "channel.update",
    channelId,
    channel: update,
  });
}

export async function emitThreadCreate(
  channelId: string,
  thread: AgentChannelThread,
): Promise<void> {
  await emitChannelEvent({
    type: "thread.create",
    channelId,
    thread,
  });
}

export async function emitCollaborationEvent(
  channelId: string,
  event: CollaborationEvent,
): Promise<void> {
  await emitChannelEvent({
    type: "collaboration.event",
    channelId,
    event,
  });
}
