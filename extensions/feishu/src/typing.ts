import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { getFeishuRuntime } from "./runtime.js";

// Feishu emoji types for typing indicator
// See: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// Full list: https://github.com/go-lark/lark/blob/main/emoji.go
const TYPING_EMOJI = "Typing"; // Typing indicator emoji

export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

/**
 * Add a typing indicator (reaction) to a message
 */
export async function addTypingIndicator(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<TypingIndicatorState> {
  const { cfg, messageId, accountId, runtime } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return { messageId, reactionId: null };
  }

  const client = createFeishuClient(account);

  try {
    const response = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: TYPING_EMOJI },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
    const reactionId = (response as any)?.data?.reaction_id ?? null;
    return { messageId, reactionId };
  } catch (err) {
    // Silently fail - typing indicator is not critical
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to add typing indicator: ${String(err)}`);
    }
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message
 */
export async function removeTypingIndicator(params: {
  cfg: ClawdbotConfig;
  state: TypingIndicatorState;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, state, accountId, runtime } = params;
  if (!state.reactionId) {
    return;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    return;
  }

  const client = createFeishuClient(account);

  try {
    await client.im.messageReaction.delete({
      path: {
        message_id: state.messageId,
        reaction_id: state.reactionId,
      },
    });
  } catch (err) {
    // Silently fail - cleanup is not critical
    if (getFeishuRuntime().logging.shouldLogVerbose()) {
      runtime?.log?.(`[feishu] failed to remove typing indicator: ${String(err)}`);
    }
  }
}
