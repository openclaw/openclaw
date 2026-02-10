/**
 * SDK client for Convos using convos-node-sdk
 * Replaces the daemon HTTP client with direct SDK integration
 */

import { Agent, createUser, createSigner, encodeText, type MessageContext } from "@xmtp/agent-sdk";
import { ConvosMiddleware, type InviteContext } from "convos-node-sdk";
import fs from "node:fs";
import path from "node:path";
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
  /**
   * Path to the XMTP local database directory.
   * - `string`: persistent DB at that path (directory created if missing).
   * - `null`: in-memory DB (for setup/probe temporary clients).
   * - `undefined`: SDK default (avoid — prefer explicit path or null).
   */
  dbPath?: string | null;
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
 * Derive a short hash from the private key so that changing the key
 * produces a fresh DB directory, avoiding "identity rowid=1" crashes.
 */
function keyHash8(privateKey: string): string {
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  return hex.slice(0, 8).toLowerCase();
}

/**
 * Build a deterministic dbPath file under the OpenClaw state directory.
 * Agent.create() expects a **file** path (SQLite DB), not a directory.
 *
 *   <stateDir>/convos/xmtp/<env>/<accountId>/<keyHash8>/xmtp.db
 */
export function resolveConvosDbPath(params: {
  stateDir: string;
  env: "production" | "dev";
  accountId: string;
  privateKey: string;
}): string {
  const hash = keyHash8(params.privateKey);
  const dir = path.join(params.stateDir, "convos", "xmtp", params.env, params.accountId, hash);
  return path.join(dir, "xmtp.db");
}

/**
 * Ensure the parent directory of a dbPath file exists and is writable.
 * Throws a clear error (instead of the opaque libxmtp "Pool error …
 * Unable to open database file") if the directory cannot be written to.
 */
export function ensureDbPathWritable(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(
      `XMTP dbPath parent dir is not writable: ${dir} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

  private constructor(agent: Agent, convos: ConvosMiddleware, userKey: string, debug: boolean) {
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

    // Build Agent options with explicit dbPath when provided.
    // string → persistent (ensure dir exists + writable); null → in-memory; undefined → SDK default.
    const agentOpts: Record<string, unknown> = { env: resolvedEnv };
    if (options.dbPath !== undefined) {
      if (typeof options.dbPath === "string") {
        ensureDbPathWritable(options.dbPath);
      }
      agentOpts.dbPath = options.dbPath;
    }

    const agent = await Agent.create(signer, agentOpts);
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
  async joinConversation(invite: string, name?: string): Promise<JoinConversationResult> {
    if (this.debug) {
      console.log(`[convos-sdk] Joining conversation with invite: ${invite.slice(0, 20)}...`);
    }

    try {
      // Snapshot existing group IDs before joining so we can diff after
      await this.agent.client.conversations.sync();
      const beforeIds = new Set(this.agent.client.conversations.listGroups().map((g) => g.id));

      const result = await this.convos.join(invite);

      if (this.debug) {
        console.log(`[convos-sdk] Join result:`, result);
      }

      if (!result.conversationId) {
        return { status: "waiting_for_acceptance", conversationId: null };
      }

      // convos.join() returns the invite token as conversationId (not the XMTP
      // group ID). The join is asynchronous — the creator agent needs time to
      // process the join request DM and add us to the group. Poll until the
      // new group appears in our conversation list.
      let conversationId: string = result.conversationId;
      const MAX_ATTEMPTS = 15;
      const POLL_INTERVAL_MS = 1000;

      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        try {
          await this.agent.client.conversations.sync();
          const groups = this.agent.client.conversations.listGroups();
          const newGroup = groups.find((g) => !beforeIds.has(g.id));
          if (newGroup) {
            conversationId = newGroup.id;
            console.log(
              `[convos-sdk] Resolved group ID: ${newGroup.id} (after ${i + 1} attempt(s))`,
            );
            if (name) {
              const convosGroup = this.convos.group(newGroup);
              await convosGroup.setConversationProfile({ name });
              console.log(`[convos-sdk] Set profile name: "${name}"`);
            }
            break;
          }
        } catch (err) {
          console.warn(`[convos-sdk] Poll attempt ${i + 1} failed:`, err);
        }
      }

      if (conversationId === result.conversationId) {
        console.warn(
          `[convos-sdk] Could not resolve group ID after ${MAX_ATTEMPTS} attempts, using raw token`,
        );
      }

      return { status: "joined", conversationId };
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

    // Set the agent's display name in the conversation so it shows
    // the agent name instead of "Somebody" in the Convos app.
    if (name) {
      try {
        await convosGroup.setConversationProfile({ name });
      } catch (err) {
        console.warn(`[convos-sdk] Failed to set profile name:`, err);
      }
    }

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
   * Rename a conversation and update the agent's profile name within it.
   */
  async renameConversation(conversationId: string, name: string): Promise<void> {
    const conversation = await this.agent.client.conversations.getConversationById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const convosGroup = this.convos.group(conversation);

    // Update the agent's member display name in the conversation
    await convosGroup.setConversationProfile({ name });

    if (this.debug) {
      console.log(`[convos-sdk] Renamed conversation ${conversationId} to "${name}"`);
    }
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

    // send() expects encoded content (type + content bytes), not a raw string.
    await conversation.send(encodeText(message));

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
