/**
 * Feishu message recall handler.
 * 
 * Handles im.message.recall_v1 events by deleting the corresponding bot reply
 * messages that were sent in response to the recalled user message.
 * 
 * Architecture:
 * - user_message_id → bot_reply_message_id[] mapping is stored in memory
 * - On outbound send: registerMapping(userMsgId, botMsgId)
 * - On recall event: deleteBotReplies(userMsgId)
 */

import { createFeishuClient } from "./client.js";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";

// In-memory mapping: user message ID → bot reply message IDs
// One user message may trigger multiple bot replies
const userToBotMessageMap = new Map<string, string[]>();

/**
 * Register that bot sent a reply to a user message.
 * Call this after sendMessageFeishu() succeeds.
 */
export function registerBotReply(userMessageId: string, botMessageId: string): void {
  const existing = userToBotMessageMap.get(userMessageId) ?? [];
  existing.push(botMessageId);
  userToBotMessageMap.set(userMessageId, existing);
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
  const botMessageIds = userToBotMessageMap.get(recalledUserMessageId);
  
  if (!botMessageIds || botMessageIds.length === 0) {
    log(`feishu[recall]: no bot replies found for recalled message ${recalledUserMessageId}`);
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

  for (const botMessageId of botMessageIds) {
    try {
      await client.im.message.delete({
        path: { message_id: botMessageId },
      });
      deletedCount++;
      log(`feishu[recall]: deleted bot reply ${botMessageId}`);
    } catch (err) {
      // 230011 = message not found / already deleted, 231003 = withdrawn
      const code = (err as { code?: number }).code;
      if (code === 230011 || code === 231003) {
        // Already gone, treat as success
        deletedCount++;
        log(`feishu[recall]: bot reply ${botMessageId} already deleted (code ${code})`);
      } else {
        failedCount++;
        log(`feishu[recall]: failed to delete ${botMessageId}: ${String(err)}`);
      }
    }
  }

  // Clean up mapping after processing
  userToBotMessageMap.delete(recalledUserMessageId);

  log(`feishu[recall]: recall processed for ${recalledUserMessageId} — deleted ${deletedCount}, failed ${failedCount}`);
}

/**
 * Check if a user message has been recalled by querying the message.
 * Returns true if the message no longer exists or returns a recall error.
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
    await client.im.message.get({ path: { message_id: userMessageId } });
    return false; // Message still exists
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 230011 = message not found / withdrawn
    if (code === 230011) return true;
    return false;
  }
}
