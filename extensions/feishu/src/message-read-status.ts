import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

/**
 * Message read status information
 */
export type FeishuMessageReadStatus = {
  messageId: string;
  chatId: string;
  totalReadCount: number;
  readUsers: FeishuReadUser[];
  unreadUsers: FeishuReadUser[];
};

/**
 * User who read/unread the message
 */
export type FeishuReadUser = {
  openId?: string;
  userId?: string;
  unionId?: string;
  name?: string;
};

/**
 * Get the read status of a message (who has read the message).
 * Uses Feishu API: GET /im/v1/messages/:message_id/read_users
 * 
 * Note: This API requires the "im:message:read_user_ids" permission.
 * The message read status feature is only available for:
 * - Private chats (p2p)
 * - Group chats with less than 500 members
 * - Messages sent by the bot itself
 */
export async function getMessageReadStatus(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageReadStatus | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.getReadUsers({
      path: { message_id: messageId },
    })) as {
      code?: number;
      msg?: string;
      data?: {
        chat_id?: string;
        message_id?: string;
        read_user_ids?: string[];
        read_user_id_list?: {
          open_id?: string[];
          user_id?: string[];
          union_id?: string[];
        };
      };
    };

    if (response.code !== 0) {
      // If the API is not supported or message not found, return null
      if (response.code === 99 || response.msg?.includes("not found")) {
        return null;
      }
      throw new Error(`Failed to get message read status: ${response.msg || `code ${response.code}`}`);
    }

    const data = response.data;
    if (!data) {
      return null;
    }

    // Parse read user IDs
    const readOpenIds = data.read_user_id_list?.open_id || [];
    const readUserIds = data.read_user_id_list?.user_id || [];
    const readUnionIds = data.read_user_id_list?.union_id || [];

    // For now, return the raw data without user details
    // The Feishu API returns user IDs but not names in this endpoint
    const readUsers: FeishuReadUser[] = [
      ...readOpenIds.map((id) => ({ openId: id })),
      ...readUserIds.map((id) => ({ userId: id })),
      ...readUnionIds.map((id) => ({ unionId: id })),
    ];

    return {
      messageId: data.message_id || messageId,
      chatId: data.chat_id || "",
      totalReadCount: readUsers.length,
      readUsers,
      unreadUsers: [], // We cannot determine unread users without the full member list
    };
  } catch (error) {
    // If the API is not available (e.g., older Feishu versions), return null
    if (error instanceof Error && error.message.includes("not supported")) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a specific user has read a message
 */
export async function hasUserReadMessage(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  userId: string;
  userIdType?: "open_id" | "user_id" | "union_id";
  accountId?: string;
}): Promise<boolean> {
  const { cfg, messageId, userId, userIdType = "open_id", accountId } = params;

  const readStatus = await getMessageReadStatus({ cfg, messageId, accountId });
  if (!readStatus) {
    return false;
  }

  return readStatus.readUsers.some((user) => {
    switch (userIdType) {
      case "open_id":
        return user.openId === userId;
      case "user_id":
        return user.userId === userId;
      case "union_id":
        return user.unionId === userId;
      default:
        return false;
    }
  });
}

/**
 * Get the read count for a message (simpler version)
 */
export async function getMessageReadCount(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<number> {
  const { cfg, messageId, accountId } = params;

  const readStatus = await getMessageReadStatus({ cfg, messageId, accountId });
  if (!readStatus) {
    return 0;
  }

  return readStatus.totalReadCount;
}
