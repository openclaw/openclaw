import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";
function buildSlackThreadingToolContext(params) {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const hasExplicitThreadTarget = params.context.MessageThreadId != null;
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  const currentChannelId = params.context.To?.startsWith("channel:") ? params.context.To.slice("channel:".length) : params.context.NativeChannelId?.trim() || void 0;
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : void 0,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef
  };
}
export {
  buildSlackThreadingToolContext
};
