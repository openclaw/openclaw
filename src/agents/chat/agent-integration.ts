/**
 * Integration helpers for connecting the multi-agent chat system
 * with existing OpenClaw agents.
 *
 * This module provides functions to:
 * - Register existing agents with the chat system
 * - Handle incoming messages and route to appropriate agents
 * - Manage agent lifecycle (join/leave channels)
 * - Bridge between session-based and channel-based messaging
 */

import type { ParsedMention } from "./routing/mention-parser.js";
import type { AgentChannel, AgentChannelMember, AgentListeningMode } from "./types/channels.js";
import type { ChannelMessage, CreateMessageParams } from "./types/messages.js";
import { coordinateMessage } from "./collaboration/coordinator.js";
import { getActiveSession } from "./collaboration/session-manager.js";
import { emitNewMessage } from "./events/channel-events.js";
import { updatePresence, heartbeat, setOffline, type AgentStatus } from "./presence/manager.js";
import { startTyping, stopTyping, onMessageSent } from "./presence/typing.js";
import { resolveTargetAgents, type RoutingContext } from "./routing/router.js";
import { getChannel, addMember, listChannels } from "./store/channel-store.js";
import { createMessage, getRecentMessages } from "./store/message-store.js";

export type AgentConfig = {
  agentId: string;
  displayName: string;
  description?: string;
  expertise?: string[];
  defaultListeningMode?: AgentListeningMode;
  autoJoinChannels?: string[];
  handleMessage: (params: IncomingMessage) => Promise<AgentResponse | null>;
};

export type IncomingMessage = {
  channelId: string;
  channel: AgentChannel;
  message: ChannelMessage;
  mentionedDirectly: boolean;
  isBroadcast: boolean;
  collaborationSession?: string;
  context: MessageContext;
};

export type MessageContext = {
  recentMessages: ChannelMessage[];
  threadMessages?: ChannelMessage[];
  channelMembers: AgentChannelMember[];
  onlineAgents: string[];
};

export type AgentResponse = {
  content: string;
  metadata?: Record<string, unknown>;
  createThread?: boolean;
  mentionAgents?: string[];
};

// Registered agents
const registeredAgents = new Map<string, AgentConfig>();

/**
 * Register an agent with the chat system.
 */
export function registerAgent(config: AgentConfig): void {
  registeredAgents.set(config.agentId, config);

  // Auto-join configured channels
  if (config.autoJoinChannels) {
    for (const channelId of config.autoJoinChannels) {
      joinChannel(config.agentId, channelId, {
        listeningMode: config.defaultListeningMode ?? "mention-only",
      }).catch(() => {
        // Channel may not exist yet
      });
    }
  }
}

/**
 * Unregister an agent.
 */
export function unregisterAgent(agentId: string): void {
  registeredAgents.delete(agentId);
}

/**
 * Get a registered agent config.
 */
export function getAgent(agentId: string): AgentConfig | undefined {
  return registeredAgents.get(agentId);
}

/**
 * List all registered agents.
 */
export function listAgents(): AgentConfig[] {
  return [...registeredAgents.values()];
}

/**
 * Join an agent to a channel.
 */
export async function joinChannel(
  agentId: string,
  channelId: string,
  options?: {
    listeningMode?: AgentListeningMode;
    customName?: string;
  },
): Promise<AgentChannelMember> {
  const agent = registeredAgents.get(agentId);
  const customName = options?.customName ?? agent?.displayName;

  const member = await addMember(channelId, agentId, {
    listeningMode: options?.listeningMode ?? "mention-only",
    customName,
  });

  // Set initial presence
  await updatePresence({
    agentId,
    channelId,
    status: "active",
    customStatus: agent?.description,
  });

  return member;
}

/**
 * Leave a channel.
 */
export async function leaveChannel(agentId: string, channelId: string): Promise<void> {
  await setOffline(agentId, channelId);
}

/**
 * Handle an incoming message and route to appropriate agents.
 */
export async function handleIncomingMessage(params: {
  channelId: string;
  content: string;
  authorId: string;
  authorType: "user" | "external";
  authorName?: string;
  threadId?: string;
}): Promise<ChannelMessage[]> {
  const channel = await getChannel(params.channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${params.channelId}`);
  }

  // Create the message
  const messageParams: CreateMessageParams = {
    channelId: params.channelId,
    authorId: params.authorId,
    authorType: params.authorType,
    authorName: params.authorName,
    content: params.content,
    threadId: params.threadId,
  };

  const message = await createMessage(messageParams);

  // Emit the new message event
  await emitNewMessage(params.channelId, message, params.authorId);

  // Check for active collaboration session
  const collaborationSession = await getActiveSession(params.channelId);
  let routing;

  if (collaborationSession) {
    // Use collaboration coordinator
    const decision = await coordinateMessage(collaborationSession, params.content, params.authorId);
    routing = {
      respondingAgents: decision.targetAgents,
      observingAgents: [],
      isBroadcast: false,
      reason: decision.reason,
      mentions: {
        explicitMentions: [] as string[],
        patternMentions: [] as string[],
        isBroadcast: false,
        strippedMessage: params.content,
        allMentions: [] as ParsedMention[],
      },
    };
  } else {
    // Normal routing based on mentions
    const agentNames = new Map<string, string>();
    for (const member of channel.members) {
      const agent = registeredAgents.get(member.agentId);
      agentNames.set(member.agentId, member.customName ?? agent?.displayName ?? member.agentId);
    }

    const routingContext: RoutingContext = {
      channelId: params.channelId,
      message: params.content,
      authorId: params.authorId,
      authorType: params.authorType,
      threadId: params.threadId,
      channel,
      agentNames,
    };

    routing = resolveTargetAgents(routingContext);
  }

  // Build context for agents
  const recentMessages = await getRecentMessages(params.channelId, 20);
  const onlineAgents = channel.members
    .filter((m) => registeredAgents.has(m.agentId))
    .map((m) => m.agentId);

  const context: MessageContext = {
    recentMessages,
    channelMembers: channel.members,
    onlineAgents,
  };

  // Invoke responding agents
  const responses: ChannelMessage[] = [];

  for (const agentId of routing.respondingAgents) {
    const agentConfig = registeredAgents.get(agentId);
    if (!agentConfig) {
      continue;
    }

    // Start typing indicator
    await startTyping(agentId, params.channelId, params.threadId);

    try {
      const incomingMessage: IncomingMessage = {
        channelId: params.channelId,
        channel,
        message,
        mentionedDirectly: routing.mentions.explicitMentions.includes(agentId),
        isBroadcast: routing.isBroadcast,
        collaborationSession: collaborationSession?.sessionId,
        context,
      };

      const response = await agentConfig.handleMessage(incomingMessage);

      if (response) {
        // Stop typing indicator
        await onMessageSent(agentId, params.channelId, params.threadId);

        // Create response message
        const responseMessage = await createMessage({
          channelId: params.channelId,
          authorId: agentId,
          authorType: "agent",
          authorName: agentConfig.displayName,
          content: response.content,
          threadId: response.createThread ? message.id : params.threadId,
          metadata: response.metadata,
        });

        await emitNewMessage(params.channelId, responseMessage, agentId);
        responses.push(responseMessage);

        // Update presence
        await heartbeat(agentId, params.channelId);
      }
    } catch (error) {
      console.error(`Agent ${agentId} failed to respond:`, error);
      await stopTyping(agentId, params.channelId, params.threadId);
    }
  }

  return responses;
}

/**
 * Send a message from an agent.
 */
export async function sendAgentMessage(params: {
  agentId: string;
  channelId: string;
  content: string;
  threadId?: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}): Promise<ChannelMessage> {
  const agentConfig = registeredAgents.get(params.agentId);
  if (!agentConfig) {
    throw new Error(`Agent not registered: ${params.agentId}`);
  }

  const message = await createMessage({
    channelId: params.channelId,
    authorId: params.agentId,
    authorType: "agent",
    authorName: agentConfig.displayName,
    content: params.content,
    threadId: params.threadId,
    parentMessageId: params.replyToId,
    metadata: params.metadata,
  });

  await emitNewMessage(params.channelId, message, params.agentId);
  await heartbeat(params.agentId, params.channelId);

  return message;
}

/**
 * Update agent status in a channel.
 */
export async function setAgentStatus(
  agentId: string,
  channelId: string,
  status: AgentStatus,
  customStatus?: string,
): Promise<void> {
  await updatePresence({
    agentId,
    channelId,
    status,
    customStatus,
  });
}

/**
 * Get all channels an agent is a member of.
 */
export async function getAgentChannels(agentId: string): Promise<AgentChannel[]> {
  return listChannels({ agentId, archived: false });
}

/**
 * Initialize the chat system for an agent.
 * Joins default channels and sets up presence.
 */
export async function initializeAgent(
  agentId: string,
  options?: {
    defaultChannels?: string[];
    status?: AgentStatus;
  },
): Promise<void> {
  const agent = registeredAgents.get(agentId);
  if (!agent) {
    throw new Error(`Agent not registered: ${agentId}`);
  }

  // Join default channels
  const channelsToJoin = options?.defaultChannels ?? agent.autoJoinChannels ?? [];
  for (const channelId of channelsToJoin) {
    try {
      await joinChannel(agentId, channelId, {
        listeningMode: agent.defaultListeningMode,
        customName: agent.displayName,
      });
    } catch {
      // Channel may not exist
    }
  }
}

/**
 * Shutdown agent - set offline in all channels.
 */
export async function shutdownAgent(agentId: string): Promise<void> {
  await setOffline(agentId);
}
