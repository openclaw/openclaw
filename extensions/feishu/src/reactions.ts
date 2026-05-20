import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

export type FeishuReaction = {
  reactionId: string;
  emojiType: string;
  operatorType: "app" | "user";
  operatorId: string;
};

type FeishuReactionApiItem = {
  reaction_id?: string;
  reaction_type?: { emoji_type?: string };
  operator?: {
    operator_id?: string;
    operator_type?: string;
  };
  operator_type?: string;
  operator_id?: string | { app_id?: string; open_id?: string; user_id?: string; union_id?: string };
};

function normalizeOperatorId(value: FeishuReactionApiItem["operator_id"]): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return (
    value?.app_id?.trim() ??
    value?.open_id?.trim() ??
    value?.user_id?.trim() ??
    value?.union_id?.trim() ??
    ""
  );
}

function normalizeReactionItem(item: FeishuReactionApiItem): FeishuReaction {
  const operatorType = item.operator?.operator_type ?? item.operator_type;
  const operatorId = item.operator?.operator_id ?? item.operator_id;
  return {
    reactionId: item.reaction_id ?? "",
    emojiType: item.reaction_type?.emoji_type ?? "",
    operatorType: operatorType === "app" ? "app" : "user",
    operatorId: normalizeOperatorId(operatorId),
  };
}

export function isFeishuReactionOwnedByApp(
  reaction: Pick<FeishuReaction, "operatorType" | "operatorId">,
  appId?: string,
): boolean {
  const normalizedAppId = appId?.trim();
  return (
    Boolean(normalizedAppId) &&
    reaction.operatorType === "app" &&
    reaction.operatorId === normalizedAppId
  );
}

function resolveConfiguredFeishuClient(params: { cfg: ClawdbotConfig; accountId?: string }) {
  const account = resolveFeishuRuntimeAccount(params);
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return createFeishuClient(account);
}

function assertFeishuReactionApiSuccess(response: { code?: number; msg?: string }, action: string) {
  if (response.code !== 0) {
    throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
  }
}

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
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: {
        emoji_type: emojiType,
      },
    },
  })) as {
    code?: number;
    msg?: string;
    data?: { reaction_id?: string };
  };

  assertFeishuReactionApiSuccess(response, "add reaction");

  const reactionId = response.data?.reaction_id;
  if (!reactionId) {
    throw new Error("Feishu add reaction failed: no reaction_id returned");
  }

  return { reactionId };
}

/**
 * Remove a reaction from a message.
 */
export async function removeReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  reactionId: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, reactionId, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  })) as { code?: number; msg?: string };

  assertFeishuReactionApiSuccess(response, "remove reaction");
}

/**
 * List all reactions for a message.
 */
export async function listReactionsFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType?: string;
  accountId?: string;
}): Promise<FeishuReaction[]> {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: emojiType ? { reaction_type: emojiType } : undefined,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: FeishuReactionApiItem[];
    };
  };

  assertFeishuReactionApiSuccess(response, "list reactions");

  const items = response.data?.items ?? [];
  return items.map(normalizeReactionItem);
}

export async function removeOwnReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType: string;
  accountId?: string;
  appId?: string;
}): Promise<FeishuReaction | undefined> {
  const matches = await listReactionsFeishu({
    cfg: params.cfg,
    messageId: params.messageId,
    emojiType: params.emojiType,
    accountId: params.accountId,
  });
  const ownReaction = matches.find((reaction) =>
    isFeishuReactionOwnedByApp(reaction, params.appId),
  );
  if (!ownReaction) {
    return undefined;
  }
  await removeReactionFeishu({
    cfg: params.cfg,
    messageId: params.messageId,
    reactionId: ownReaction.reactionId,
    accountId: params.accountId,
  });
  return ownReaction;
}

export async function removeOwnReactionsFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
  appId?: string;
}): Promise<number> {
  const reactions = await listReactionsFeishu({
    cfg: params.cfg,
    messageId: params.messageId,
    accountId: params.accountId,
  });
  let removed = 0;
  for (const reaction of reactions.filter((entry) =>
    isFeishuReactionOwnedByApp(entry, params.appId),
  )) {
    await removeReactionFeishu({
      cfg: params.cfg,
      messageId: params.messageId,
      reactionId: reaction.reactionId,
      accountId: params.accountId,
    });
    removed += 1;
  }
  return removed;
}
