import type { DeltaChatOverJsonRpcServer } from "@deltachat/stdio-rpc-server";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveDeltaChatAccount } from "./accounts.js";
import { rpcServerManager } from "./rpc-server.js";

export type DeltaChatReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type ResolvedDeltaChatReactionLevel = {
  level: DeltaChatReactionLevel;
  /** Whether ACK reactions (e.g., 👀 when processing) are enabled. */
  ackEnabled: boolean;
  /** Whether agent-controlled reactions are enabled. */
  agentReactionsEnabled: boolean;
  /** Guidance level for agent reactions (minimal = sparse, extensive = liberal). */
  agentReactionGuidance?: "minimal" | "extensive";
};

/**
 * Resolve the effective reaction level and its implications for Delta.Chat.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
 * - "minimal": Agent can react, but sparingly (default)
 * - "extensive": Agent can react liberally
 */
export function resolveDeltaChatReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDeltaChatReactionLevel {
  const account = resolveDeltaChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const level = (account.config.reactionLevel ?? "minimal") as DeltaChatReactionLevel;

  switch (level) {
    case "off":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: false,
      };
    case "ack":
      return {
        level,
        ackEnabled: true,
        agentReactionsEnabled: false,
      };
    case "minimal":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
    case "extensive":
      return {
        level,
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "extensive",
      };
    default:
      // Fallback to minimal behavior
      return {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
  }
}

export type DeltaChatReactionOpts = {
  accountId?: string;
  dataDir?: string;
  timeoutMs?: number;
};

export type DeltaChatReactionResult = {
  ok: boolean;
  error?: string;
};

/**
 * Normalize Delta.Chat reaction parameters.
 * Handles chat ID, message ID, emoji, and removal flag.
 */
export function normalizeDeltaChatReactionParams(params: {
  target: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}): { chatId: number; messageId: number; emoji?: string; remove: boolean } {
  const trimmedTarget = params.target?.trim();
  const trimmedMessageId = params.messageId?.trim();
  const trimmedEmoji = params.emoji?.trim();

  if (!trimmedTarget) {
    throw new Error("Target (chat ID or email) is required for Delta.Chat reaction");
  }

  if (!trimmedMessageId) {
    throw new Error("Message ID is required for Delta.Chat reaction");
  }

  // Parse chat ID - could be a numeric ID or need to be resolved
  let chatId: number;
  if (/^\d+$/.test(trimmedTarget)) {
    chatId = parseInt(trimmedTarget, 10);
  } else {
    // For email addresses, we need to resolve them to chat IDs
    // This will be handled by the caller who has access to the RPC server
    throw new Error(
      "Chat ID must be numeric for Delta.Chat reactions. Use the numeric chat ID from the message context.",
    );
  }

  const messageId = parseInt(trimmedMessageId, 10);
  if (!Number.isFinite(messageId) || messageId <= 0) {
    throw new Error("Valid message ID is required for Delta.Chat reaction");
  }

  const remove = params.remove ?? false;

  // If removing, emoji is optional (removes all reactions if not specified)
  // If adding, emoji is required
  if (!remove && !trimmedEmoji) {
    throw new Error("Emoji is required when adding a Delta.Chat reaction");
  }

  return {
    chatId,
    messageId,
    emoji: trimmedEmoji,
    remove,
  };
}

/**
 * Send a reaction to a Delta.Chat message.
 * Uses dc.rpc.sendReaction() RPC method.
 *
 * @param chatId - The numeric chat ID
 * @param messageId - The numeric message ID to react to
 * @param emoji - The emoji to react with (e.g., "👍", "✅")
 * @param opts - Optional account/connection overrides
 * @returns Result indicating success or failure
 */
export async function sendReactionDeltaChat(
  chatId: number,
  messageId: number,
  emoji: string,
  opts: DeltaChatReactionOpts = {},
): Promise<DeltaChatReactionResult> {
  const account = resolveDeltaChatAccount({
    cfg: { channels: { deltachat: {} } } as OpenClawConfig,
    accountId: opts.accountId,
  });

  // Validate inputs
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return { ok: false, error: "Valid chat ID is required" };
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return { ok: false, error: "Valid message ID is required" };
  }
  if (!emoji?.trim()) {
    return { ok: false, error: "Emoji is required" };
  }

  // Get or start the RPC server
  const dc = await rpcServerManager.start(account.config.dataDir);
  if (!dc) {
    return { ok: false, error: "Failed to start Delta.Chat RPC server" };
  }

  try {
    // Delta.Chat's sendReaction RPC expects:
    // - accountId: The account ID (numeric)
    // - messageId: The message ID to react to
    // - reaction: Array of emoji strings to add (empty array removes all)
    //
    // Note: Delta.Chat doesn't use chatId in sendReaction - it's inferred from the message
    // The message ID is unique across all chats in Delta.Chat

    const accountId = await resolveDeltaChatAccountId(dc, account.accountId);
    if (accountId === null) {
      return { ok: false, error: "Could not resolve Delta.Chat account ID" };
    }

    // For adding a reaction, pass array with the emoji
    // For removing, pass empty array (removes all)
    const reaction = [emoji.trim()];

    await dc.rpc.sendReaction(accountId, messageId, reaction);

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to send reaction: ${errorMessage}` };
  }
}

/**
 * Remove a reaction from a Delta.Chat message.
 * Uses dc.rpc.sendReaction() RPC method with empty array.
 *
 * @param chatId - The numeric chat ID
 * @param messageId - The numeric message ID to remove reaction from
 * @param emoji - The emoji to remove (optional - if not specified, removes all reactions)
 * @param opts - Optional account/connection overrides
 * @returns Result indicating success or failure
 */
export async function removeReactionDeltaChat(
  chatId: number,
  messageId: number,
  emoji?: string,
  opts: DeltaChatReactionOpts = {},
): Promise<DeltaChatReactionResult> {
  const account = resolveDeltaChatAccount({
    cfg: { channels: { deltachat: {} } } as OpenClawConfig,
    accountId: opts.accountId,
  });

  // Validate inputs
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return { ok: false, error: "Valid chat ID is required" };
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return { ok: false, error: "Valid message ID is required" };
  }

  // Get or start the RPC server
  const dc = await rpcServerManager.start(account.config.dataDir);
  if (!dc) {
    return { ok: false, error: "Failed to start Delta.Chat RPC server" };
  }

  try {
    const accountId = await resolveDeltaChatAccountId(dc, account.accountId);
    if (accountId === null) {
      return { ok: false, error: "Could not resolve Delta.Chat account ID" };
    }

    // To remove a specific reaction, we need to get current reactions first
    // and then send the remaining ones
    if (emoji?.trim()) {
      const reactionResult = await dc.rpc.getMessageReactions(accountId, messageId);
      if (reactionResult) {
        // reactionResult.reactions is an array of { emoji: string, count: number } objects
        const remainingReactions = reactionResult.reactions
          .filter((r: { emoji: string }) => r.emoji !== emoji.trim())
          .map((r: { emoji: string }) => r.emoji);
        await dc.rpc.sendReaction(accountId, messageId, remainingReactions);
      }
      // If reactionResult is null, there are no reactions to remove
    } else {
      // Remove all reactions by sending empty array
      await dc.rpc.sendReaction(accountId, messageId, []);
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to remove reaction: ${errorMessage}` };
  }
}

/**
 * Get reactions on a Delta.Chat message.
 * Uses dc.rpc.getMessageReactions() RPC method.
 *
 * @param chatId - The numeric chat ID
 * @param messageId - The numeric message ID
 * @param opts - Optional account/connection overrides
 * @returns Array of emoji strings representing reactions
 */
export async function getReactionsDeltaChat(
  chatId: number,
  messageId: number,
  opts: DeltaChatReactionOpts = {},
): Promise<string[]> {
  const account = resolveDeltaChatAccount({
    cfg: { channels: { deltachat: {} } } as OpenClawConfig,
    accountId: opts.accountId,
  });

  // Validate inputs
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new Error("Valid chat ID is required");
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    throw new Error("Valid message ID is required");
  }

  // Get or start the RPC server
  const dc = await rpcServerManager.start(account.config.dataDir);
  if (!dc) {
    throw new Error("Failed to start Delta.Chat RPC server");
  }

  try {
    const accountId = await resolveDeltaChatAccountId(dc, account.accountId);
    if (accountId === null) {
      throw new Error("Could not resolve Delta.Chat account ID");
    }

    const reactionResult = await dc.rpc.getMessageReactions(accountId, messageId);
    if (!reactionResult) {
      return [];
    }

    // reactionResult.reactions is an array of { emoji: string, count: number } objects
    // Return just the emoji strings
    return reactionResult.reactions.map((r: { emoji: string }) => r.emoji);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get reactions: ${errorMessage}`);
  }
}

/**
 * Resolve the numeric Delta.Chat account ID from the account identifier.
 * Delta.Chat uses numeric account IDs internally.
 */
async function resolveDeltaChatAccountId(
  dc: DeltaChatOverJsonRpcServer,
  accountId: string,
): Promise<number | null> {
  try {
    const accounts = await dc.rpc.getAllAccounts();
    // If no specific account ID is provided, use the first account
    if (!accountId || accountId === "default") {
      if (accounts.length === 0) {
        return null;
      }
      return accounts[0].id;
    }

    // Try to find account by ID
    // Account type has 'kind' field - only Configured accounts have 'addr'
    const account = accounts.find((a) => {
      if (a.id.toString() === accountId) {
        return true;
      }
      if (a.kind === "Configured" && "addr" in a && a.addr === accountId) {
        return true;
      }
      return false;
    });
    return account ? account.id : null;
  } catch {
    return null;
  }
}
