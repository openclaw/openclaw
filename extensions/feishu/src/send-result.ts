export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

/** Known Feishu API error codes related to permissions.
 * See: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json */
const PERMISSION_ERROR_CODES = new Set([
  99991663, // No permission to send messages to this chat
  99991664, // No permission to @mention users
  99991665, // No permission to send cards
  99991666, // No permission to send messages
  99991668, // Bot not in group
  99991669, // Group has been dissolved
  99991670, // Chat is read-only
  99991671, // Chat is muted
  230017, // Chat member not found
  230019, // Bot not in chat
  230020, // Chat not found
  230001, // Internal server error (sometimes permission related)
]);

/** Maps error codes to helpful messages about missing permissions. */
function getPermissionHint(code: number): string | null {
  const hints: Record<number, string> = {
    99991663: "The bot doesn't have permission to send messages to this chat. Ensure the app has 'im:message' permission and is added to the group.",
    99991664: "The bot doesn't have permission to @mention users. Ensure the app has 'im:message' permission.",
    99991665: "The bot doesn't have permission to send interactive cards. Ensure the app has 'im:message' and 'im:resource' permissions.",
    99991666: "The bot doesn't have permission to send messages. Ensure the app has 'im:message:send_as_bot' permission and is published.",
    99991668: "The bot is not a member of this group. Add the bot to the group first.",
    99991669: "This group has been dissolved.",
    99991670: "This chat is read-only and cannot receive messages.",
    99991671: "This chat is muted for the bot.",
    230017: "The user or bot is not a member of this chat. Ensure the bot is added to the group.",
    230019: "The bot is not in this chat. Add the bot to the group first.",
    230020: "The chat doesn't exist or has been deleted.",
  };
  return hints[code] || null;
}

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    const code = response.code;
    const msg = response.msg || `code ${code}`;
    
    // Check if this is a permission-related error
    if (code !== undefined && PERMISSION_ERROR_CODES.has(code)) {
      const hint = getPermissionHint(code);
      const hintText = hint ? `\n\n💡 Hint: ${hint}` : "";
      const docsLink = "\n📖 See: https://docs.openclaw.ai/channels/feishu#troubleshooting";
      throw new Error(`${errorPrefix}: ${msg}${hintText}${docsLink}`);
    }
    
    throw new Error(`${errorPrefix}: ${msg}`);
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
): {
  messageId: string;
  chatId: string;
} {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
  };
}
