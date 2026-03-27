/**
 * Feishu message recall handler.
 *
 * Handles im.message.recalled_v1 events by deleting the corresponding bot reply
 * messages that were sent in response to the recalled user message.
 *
 * Architecture:
 * - user_message_id → { botReplyIds: string[], timestamp: number } mapping is stored in memory
 * - On outbound send: registerBotReply(userMsgId, botMsgId, viaReplyPath)
 * - On recall event: deleteBotReplies(userMsgId)
 * - TTL eviction: mappings expire after 24h to prevent memory leaks
 */

import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface MappingEntry {
  botReplyIds: string[];
  timestamp: number;
  viaReplyPath: boolean; // true only if sent via im.message.reply (user can recall)
}

// In-memory mapping: user message ID → { botReplyIds, timestamp, viaReplyPath }
// One user message may trigger multiple bot replies.
// viaReplyPath=false entries are from fallback direct sends (user can't recall those).
const userToBotMessageMap = new Map<string, MappingEntry>();

/**
 * Evict expired entries to prevent memory leaks.
 * Call this periodically or on each registerBotReply call.
 */
function evictExpiredMappings(): void {
  const now = Date.now();
  for (const [userMsgId, entry] of userToBotMessageMap.entries()) {
    if (now - entry.timestamp > MESSAGE_TTL_MS) {
      userToBotMessageMap.delete(userMsgId);
    }
  }
}

/**
 * Register that bot sent a reply to a user message.
 * Call this after sendMessageFeishu() succeeds via the reply path.
 *
 * @param userMessageId  - The user's message ID this bot is replying to
 * @param botMessageId   - The bot's newly sent message ID
 * @param viaReplyPath   - True if sent via im.message.reply (user CAN recall).
 *                         False if fell back to direct send (user CANNOT recall).
 *                         Defaults to true for backward compatibility.
 * @returns true if registered, false if not registered (e.g., fallback path)
 */
export function registerBotReply(
  userMessageId: string,
  botMessageId: string,
  viaReplyPath = true,
): boolean {
  // Only register mappings for true reply-path sends.
  // Fallback direct sends cannot be recalled by the user.
  if (!viaReplyPath) {
    return false;
  }

  // Periodically evict old entries (every ~100 calls)
  if (userToBotMessageMap.size > 100 && userToBotMessageMap.size % 100 === 0) {
    evictExpiredMappings();
  }

  const existing = userToBotMessageMap.get(userMessageId);
  if (existing) {
    existing.botReplyIds.push(botMessageId);
    // Keep newest timestamp and true viaReplyPath
    existing.timestamp = Date.now();
    existing.viaReplyPath = existing.viaReplyPath && viaReplyPath;
  } else {
    userToBotMessageMap.set(userMessageId, {
      botReplyIds: [botMessageId],
      timestamp: Date.now(),
      viaReplyPath,
    });
  }
  return true;
}

/**
 * Delete all bot replies linked to a recalled user message.
 * Idempotent: safe to call multiple times, deleting non-existent messages is not an error.
 */
export async function deleteBotReplies(params: {
  cfg: ClawdbotConfig;
  recalledUserMessageId: string;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const { cfg, recalledUserMessageId, accountId, log = console.log } = params;
  const entry = userToBotMessageMap.get(recalledUserMessageId);

  if (!entry || entry.botReplyIds.length === 0) {
    log(`feishu[recall]: no bot replies found for recalled message ${recalledUserMessageId}`);
    return;
  }

  // Skip non-reply-path entries (user can't recall fallback direct sends)
  if (!entry.viaReplyPath) {
    log(
      `feishu[recall]: message ${recalledUserMessageId} was sent via fallback, cannot be recalled`,
    );
    userToBotMessageMap.delete(recalledUserMessageId);
    return;
  }

  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    log(`feishu[recall]: account "${account.accountId}" not configured, skipping`);
    return;
  }

  const client = createFeishuClient(account);
  let deletedCount = 0;
  let failedCount = 0;

  for (const botMessageId of entry.botReplyIds) {
    try {
      const response = await client.im.message.delete({
        path: { message_id: botMessageId },
      });
      // Treat non-zero code as failure (not just thrown errors)
      if (response.code !== undefined && response.code !== 0) {
        if (response.code === 230011 || response.code === 231003) {
          // Already gone
          deletedCount++;
          log(`feishu[recall]: bot reply ${botMessageId} already deleted (code ${response.code})`);
        } else {
          failedCount++;
          log(
            `feishu[recall]: failed to delete ${botMessageId}: code ${response.code} ${response.msg ?? ""}`,
          );
        }
      } else {
        deletedCount++;
        log(`feishu[recall]: deleted bot reply ${botMessageId}`);
      }
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 230011 || code === 231003) {
        deletedCount++;
        log(`feishu[recall]: bot reply ${botMessageId} already deleted (caught code ${code})`);
      } else {
        failedCount++;
        log(`feishu[recall]: failed to delete ${botMessageId}: ${String(err)}`);
      }
    }
  }

  // Only clean up mapping if all messages were deleted (or already gone)
  // If some failed with transient errors, keep them for retry on next recall event
  if (failedCount === 0) {
    userToBotMessageMap.delete(recalledUserMessageId);
    log(
      `feishu[recall]: recall processed for ${recalledUserMessageId} — deleted ${deletedCount}, mapping cleared`,
    );
  } else {
    log(
      `feishu[recall]: recall processed for ${recalledUserMessageId} — deleted ${deletedCount}, failed ${failedCount}, mapping retained for retry`,
    );
  }
}

/**
 * Check if a user message has been recalled by querying the message.
 * Returns true if the message no longer exists or returns a recall error code.
 */
export async function isMessageRecalled(params: {
  cfg: ClawdbotConfig;
  userMessageId: string;
  accountId?: string;
}): Promise<boolean> {
  const { cfg, userMessageId, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) return false;

  const client = createFeishuClient(account);
  try {
    const response = await client.im.message.get({ path: { message_id: userMessageId } });
    // Feishu API can return resolved response with non-zero code
    if (response.code !== undefined && response.code !== 0) {
      if (response.code === 230011) return true; // message not found / withdrawn
      return false;
    }
    return false; // Message still exists
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 230011) return true;
    return false;
  }
}
