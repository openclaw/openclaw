import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage } from "./bot.js";
function buildCardActionTextFallback(event) {
  const actionValue = event.action.value;
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      return actionValue.text;
    }
    if ("command" in actionValue && typeof actionValue.command === "string") {
      return actionValue.command;
    }
    return JSON.stringify(actionValue);
  }
  return String(actionValue);
}
async function handleFeishuCardAction(params) {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const content = buildCardActionTextFallback(event);
  const messageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id
      }
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: event.context.chat_id ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content })
    }
  };
  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`
  );
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId
  });
}
export {
  handleFeishuCardAction
};
