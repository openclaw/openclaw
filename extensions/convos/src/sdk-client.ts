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
 * XMTP message timestamps are often exposed as nanoseconds (sentAtNs) and may be bigint.
 * This helper normalizes to a safe JS Date.
 */
function dateFromSentAtNs(sentAtNs: unknown): Date {
  try {
    if (typeof sentAtNs === "bigint") {
      const ms = sentAtNs / 1_000_000n;
      const n = Number(ms);
      return Number.isFinite(n) ? new Date(n) : new Date();
    }
    if (typeof sentAtNs === "number") {
      const n = Math.floor(sentAtNs / 1_000_000);
      return Number.isFinite(n) ? new Date(n) : new Date();
    }
    return new Date();
  } catch {
    return new Date();
  }
}

function readSentAtNs(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (obj as any).sentAtNs;
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

    const resolvedEnv = options.env ?? "production";
    const signer = createSigner(user);
    const agent = await Agent.create(signer, { env: resolvedEnv });
    const convos = ConvosMiddleware.create(agent, { privateKey: user.key, env: resolvedEnv });
    agent.use(convos.middleware());

    console.log(`[convos-sdk] XMTP env: ${resolvedEnv}, inboxId: ${agent.client.inboxId}`);

    const client = new ConvosSDKClient(agent, convos, user.key, debug);

    // Wire up event handlers
    if (options.onInvite) {
      convos.on("invite", options.onInvite);
    }

    if (options.onMessage) {
      agent.on("message", (ctx: MessageContext) => {
        try {
          const senderId = ctx.message.senderInboxId;

          // Prevent echo-loops / double-processing: ignore our own outbound messages
          if (senderId === agent.client.inboxId) {
            return;
          }

          const content = typeof ctx.message.content === "string" ? ctx.message.content : "";
          const trimmed = content.trim();

          // Ignore empty or non-text messages for now (reactions/attachments/etc.)
          if (!trimmed) {
            if (debug && content === "") {
              console.log("[convos-sdk] Ignoring non-text/empty message");
            }
            return;
          }

          const msg: InboundMessage = {
            conversationId: ctx.conversation.id,
            messageId: ctx.message.id,
            senderId,
            senderName: "", // SDK doesn't expose display name; channel.ts falls back to truncated senderId
            content,
            timestamp: dateFromSentAtNs(readSentAtNs(ctx.message)),
          };

          // Avoid synchronous re-entrancy into the OpenClaw reply pipeline.
          queueMicrotask(() => {
            try {
              options.onMessage?.(msg);
            } catch (err) {
              if (debug) {
                console.error("[convos-sdk] onMessage handler threw:", err);
              }
            }
          });
        } catch (err) {
          if (debug) {
            console.error("[convos-sdk] Failed processing inbound message event:", err);
          }
        }
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
   * Create a new conversation with invite URL
   */
  async createConversation(name?: string): Promise<CreateConversationResult> {
    if (this.debug) {
      console.log(`[convos-sdk] Creating conversation: ${name ?? "OpenClaw"}`);
    }

    // Create XMTP group first
    const group = await this.agent.client.conversations.createGroup([]);

    if (this.debug) {
      console.log(`[convos-sdk] Created XMTP group: ${group.id}`);
    }

    // Wrap with Convos to get invite functionality
    const convosGroup = this.convos.group(group);

    // Create invite (automatically manages metadata)
    const invite = await convosGroup.createInvite({ name });

    // Always log invite details for diagnostics
    console.log(`[convos-sdk] Created invite: url=${invite.url}`);
    console.log(`[convos-sdk] Invite slug length: ${invite.slug.length}`);
    console.log(`[convos-sdk] Agent inboxId: ${this.agent.client.inboxId}`);

    return {
      conversationId: group.id,
      inviteSlug: invite.slug,
      inviteUrl: invite.url,
    };
  }

  /**
   * Get or create invite slug for a conversation
   */
  async getInvite(conversationId: string): Promise<InviteResult> {
    const conversation = await this.agent.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // Wrap with Convos and create a new invite
    // Note: SDK doesn't have a "get existing invite" method, so we create a new one
    const convosGroup = this.convos.group(conversation);
    const invite = await convosGroup.createInvite();

    return {
      inviteSlug: invite.slug,
    };
  }

  /**
   * List messages in a conversation
   */
  async listMessages(conversationId: string, limit?: number): Promise<MessageInfo[]> {
    const conversation = await this.agent.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      return [];
    }

    const messages = await conversation.messages({ limit: limit ?? 50 });

    return messages
      .map((msg) => {
        const content = typeof msg.content === "string" ? msg.content : "";
        return {
          id: msg.id,
          conversationId,
          senderId: msg.senderInboxId,
          senderName: "",
          content,
          timestamp: dateFromSentAtNs(readSentAtNs(msg)).toISOString(),
        };
      })
      .filter((m) => m.content.trim().length > 0);
  }

  /**
   * Send a message to a conversation
   */
  async sendMessage(
    conversationId: string,
    message: string,
  ): Promise<{ success: boolean; messageId?: string }> {
    if (this.debug) {
      console.log(`[convos-sdk] Sending message to ${conversationId.slice(0, 8)}...`);
    }

    const conversation = await this.agent.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const messageId = await conversation.send(message);

    return { success: true, messageId: typeof messageId === "string" ? messageId : undefined };
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

    const conversation = await this.agent.client.conversations.getConversationById(conversationId);
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
