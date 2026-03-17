import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
function resolveConfiguredFeishuClient(params) {
  const account = resolveFeishuAccount(params);
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return createFeishuClient(account);
}
function assertFeishuReactionApiSuccess(response, action) {
  if (response.code !== 0) {
    throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
  }
}
async function addReactionFeishu(params) {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });
  const response = await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: {
        emoji_type: emojiType
      }
    }
  });
  assertFeishuReactionApiSuccess(response, "add reaction");
  const reactionId = response.data?.reaction_id;
  if (!reactionId) {
    throw new Error("Feishu add reaction failed: no reaction_id returned");
  }
  return { reactionId };
}
async function removeReactionFeishu(params) {
  const { cfg, messageId, reactionId, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });
  const response = await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId
    }
  });
  assertFeishuReactionApiSuccess(response, "remove reaction");
}
async function listReactionsFeishu(params) {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });
  const response = await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: emojiType ? { reaction_type: emojiType } : void 0
  });
  assertFeishuReactionApiSuccess(response, "list reactions");
  const items = response.data?.items ?? [];
  return items.map((item) => ({
    reactionId: item.reaction_id ?? "",
    emojiType: item.reaction_type?.emoji_type ?? "",
    operatorType: item.operator_type === "app" ? "app" : "user",
    operatorId: item.operator_id?.open_id ?? item.operator_id?.user_id ?? item.operator_id?.union_id ?? ""
  }));
}
const FeishuEmoji = {
  // Common reactions
  THUMBSUP: "THUMBSUP",
  THUMBSDOWN: "THUMBSDOWN",
  HEART: "HEART",
  SMILE: "SMILE",
  GRINNING: "GRINNING",
  LAUGHING: "LAUGHING",
  CRY: "CRY",
  ANGRY: "ANGRY",
  SURPRISED: "SURPRISED",
  THINKING: "THINKING",
  CLAP: "CLAP",
  OK: "OK",
  FIST: "FIST",
  PRAY: "PRAY",
  FIRE: "FIRE",
  PARTY: "PARTY",
  CHECK: "CHECK",
  CROSS: "CROSS",
  QUESTION: "QUESTION",
  EXCLAMATION: "EXCLAMATION"
};
export {
  FeishuEmoji,
  addReactionFeishu,
  listReactionsFeishu,
  removeReactionFeishu
};
