/**
 * SDK client for Convos using convos-node-sdk
 * Replaces the daemon HTTP client with direct SDK integration
 */

import { Agent, createUser, createSigner, type MessageContext } from "@xmtp/agent-sdk";
import { ConvosMiddleware, type InviteContext } from "convos-node-sdk";
import type {
  ConversationInfo,
  JoinConversationResult,
  CreateConversationResult,
  InviteResult,
  MessageInfo,
} from "./types.js";

export interface ConvosSDKClientOptions {
  /** Hex-encoded private key (generated if not provided) */
  privateKey?: string;
  /** XMTP environment */
  env?: "production" | "dev";
  /** Handler for incoming messages */
  onMessage?: (msg: InboundMessage) => void;
  /** Handler for incoming invite/join requests */
  onInvite?: (ctx: InviteContext) => Promise<void>;
  /** Debug logging */
  debug?: boolean;
}

export interface InboundMessage {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
}

/**
 * Convos SDK Client - wraps convos-node-sdk for OpenClaw use
 */
export class ConvosSDKClient {
  private agent: Agent;
  private convos: ConvosMiddleware;
  private userKey: string;
  private running = false;
  private debug: boolean;

  private constructor(
    agent: Agent,
    convos: ConvosMiddleware,
    userKey: string,
    debug: boolean,
  ) {
    this.agent = agent;
    this.convos = convos;
    this.userKey = userKey;
    this.debug = debug;
  }

  /**
   * Create a new SDK client
   */
  static async create(options: ConvosSDKClientOptions): Promise<ConvosSDKClient> {
    const debug = options.debug ?? false;

    // Create or restore user from privateKey
    let user: ReturnType<typeof createUser>;
    if (options.privateKey) {
      // Restore from existing key
      user = createUser(options.privateKey);
      if (debug) {
        console.log("[convos-sdk] Restored user from private key");
      }
    } else {
      // Generate new user
      user = createUser();
      if (debug) {
        console.log("[convos-sdk] Generated new user");
      }
    }

    const signer = createSigner(user);
    const agent = await Agent.create(signer, {
      env: options.env ?? "production",
    });

    const convos = ConvosMiddleware.create(agent, { privateKey: user.key });
    agent.use(convos.middleware());

    const client = new ConvosSDKClient(agent, convos, user.key, debug);

    // Wire up event handlers
    if (options.onInvite) {
      convos.on("invite", options.onInvite);
    }

    if (options.onMessage) {
      agent.on("message", (ctx: MessageContext) => {
        const msg: InboundMessage = {
          conversationId: ctx.conversation.id,
          messageId: ctx.message.id,
          senderId: ctx.message.senderInboxId,
          senderName: ctx.message.senderInboxId, // SDK doesn't expose display name directly
          content: typeof ctx.message.content === "string" ? ctx.message.content : "",
          timestamp: new Date(ctx.message.sentAtNs / 1_000_000),
        };
        options.onMessage!(msg);
      });
    }

    return client;
  }

  /**
   * Start listening for messages
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.debug) {
      console.log("[convos-sdk] Starting agent...");
    }

    await this.agent.start();

    if (this.debug) {
      console.log("[convos-sdk] Agent started");
    }
  }

  /**
   * Stop the client and cleanup
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.debug) {
      console.log("[convos-sdk] Stopping agent...");
    }

    await this.agent.stop();

    if (this.debug) {
      console.log("[convos-sdk] Agent stopped");
    }
  }

  /**
   * Join a conversation via invite URL or slug
   */
  async joinConversation(invite: string): Promise<JoinConversationResult> {
    if (this.debug) {
      console.log(`[convos-sdk] Joining conversation with invite: ${invite.slice(0, 20)}...`);
    }

    try {
      const result = await this.convos.join(invite);

      if (this.debug) {
        console.log(`[convos-sdk] Join result:`, result);
      }

      return {
        status: result.conversationId ? "joined" : "waiting_for_acceptance",
        conversationId: result.conversationId ?? null,
      };
    } catch (err) {
      if (this.debug) {
        console.error(`[convos-sdk] Join failed:`, err);
      }
      throw err;
    }
  }

  /**
   * List all conversations
   */
  async listConversations(): Promise<ConversationInfo[]> {
    const conversations = await this.agent.conversations.list();

    return conversations.map((conv) => ({
      id: conv.id,
      displayName: conv.name ?? conv.id.slice(0, 8),
      memberCount: conv.members?.length ?? 0,
      isUnread: false,
      isPinned: false,
      isMuted: false,
      kind: "group",
      createdAt: new Date().toISOString(),
      lastMessagePreview: undefined,
    }));
  }

  /**
   * Create a new conversation
   */
  async createConversation(name?: string): Promise<CreateConversationResult> {
    const result = await this.convos.createConversation(name);

    // The SDK returns the full invite URL
    const inviteUrl = result.inviteUrl ?? `https://popup.convos.org/v2?i=${result.inviteSlug}`;

    return {
      conversationId: result.conversationId,
      inviteSlug: result.inviteSlug,
      inviteUrl,
    };
  }

  /**
   * Get invite slug for a conversation
   */
  async getInvite(conversationId: string): Promise<InviteResult> {
    const result = await this.convos.getInvite(conversationId);

    return {
      inviteSlug: result.slug,
    };
  }

  /**
   * List messages in a conversation
   */
  async listMessages(conversationId: string, limit?: number): Promise<MessageInfo[]> {
    const conversation = await this.agent.conversations.getById(conversationId);
    if (!conversation) {
      return [];
    }

    const messages = await conversation.messages({ limit: limit ?? 50 });

    return messages.map((msg) => ({
      id: msg.id,
      conversationId,
      senderId: msg.senderInboxId,
      senderName: msg.senderInboxId,
      content: typeof msg.content === "string" ? msg.content : "",
      timestamp: new Date(msg.sentAtNs / 1_000_000).toISOString(),
    }));
  }

  /**
   * Send a message to a conversation
   */
  async sendMessage(conversationId: string, message: string): Promise<{ success: boolean }> {
    if (this.debug) {
      console.log(`[convos-sdk] Sending message to ${conversationId.slice(0, 8)}...`);
    }

    const conversation = await this.agent.conversations.getById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    await conversation.send(message);

    return { success: true };
  }

  /**
   * Add or remove a reaction
   */
  async react(
    conversationId: string,
    messageId: string,
    emoji: string,
    remove?: boolean,
  ): Promise<{ success: boolean; action: "added" | "removed" }> {
    if (this.debug) {
      console.log(
        `[convos-sdk] ${remove ? "Removing" : "Adding"} reaction ${emoji} on ${messageId}`,
      );
    }

    const conversation = await this.agent.conversations.getById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    if (remove) {
      await conversation.removeReaction(messageId, emoji);
    } else {
      await conversation.addReaction(messageId, emoji);
    }

    return { success: true, action: remove ? "removed" : "added" };
  }

  /**
   * Get the private key for config storage
   */
  getPrivateKey(): string {
    return this.userKey;
  }

  /**
   * Check if the client is running
   */
  isRunning(): boolean {
    return this.running;
  }
}
