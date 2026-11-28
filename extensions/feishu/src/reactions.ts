import type { ClawdbotConfig } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { createConfiguredFeishuClient } from "./configured-client.js";

type FeishuReaction = {
  reactionId: string;
  emojiType: string;
  operatorType: "app" | "user" | "unknown";
  operatorId: string;
};

/**
 * Add a reaction (emoji) to a message.
 * @param emojiType - Feishu emoji type, e.g., "SMILE", "THUMBSUP", "HEART"
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
export async function addReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType: string;
  accountId?: string;
}): Promise<{ reactionId: string }> {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = createConfiguredFeishuClient({ cfg, accountId });

  const response = await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: {
        emoji_type: emojiType,
      },
    },
  });

  assertFeishuApiSuccess(response, "Feishu add reaction failed");

  const reactionId = response.data?.reaction_id;
  if (!reactionId) {
    throw new Error("Feishu add reaction failed: no reaction_id returned");
  }

  return { reactionId };
}

export async function removeReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  reactionId: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, reactionId, accountId } = params;
  const client = createConfiguredFeishuClient({ cfg, accountId });

  const response = await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  });

  assertFeishuApiSuccess(response, "Feishu remove reaction failed");
}

export async function listReactionsFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType?: string;
  accountId?: string;
}): Promise<FeishuReaction[]> {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = createConfiguredFeishuClient({ cfg, accountId });
  const reactions: FeishuReaction[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const response = await client.im.messageReaction.list({
      path: { message_id: messageId },
      params:
        emojiType || pageToken
          ? {
              ...(emojiType ? { reaction_type: emojiType } : {}),
              ...(pageToken ? { page_token: pageToken } : {}),
            }
          : undefined,
    });

    assertFeishuApiSuccess(response, "Feishu list reactions failed");

    for (const item of response.data?.items ?? []) {
      reactions.push({
        reactionId: item.reaction_id ?? "",
        emojiType: item.reaction_type?.emoji_type ?? "",
        operatorType:
          item.operator?.operator_type === "app"
            ? "app"
            : item.operator?.operator_type === "user"
              ? "user"
              : "unknown",
        operatorId: item.operator?.operator_id ?? "",
      });
    }

    if (response.data?.has_more !== true) {
      return reactions;
    }

    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken) {
      throw new Error("Feishu reaction pagination is missing its next page token");
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("Feishu reaction pagination returned a repeated page token");
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
}
