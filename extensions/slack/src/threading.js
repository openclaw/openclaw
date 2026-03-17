function resolveSlackThreadContext(params) {
  const incomingThreadTs = params.message.thread_ts;
  const eventTs = params.message.event_ts;
  const messageTs = params.message.ts ?? eventTs;
  const hasThreadTs = typeof incomingThreadTs === "string" && incomingThreadTs.length > 0;
  const isThreadReply = hasThreadTs && (incomingThreadTs !== messageTs || Boolean(params.message.parent_user_id));
  const replyToId = incomingThreadTs ?? messageTs;
  const messageThreadId = isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0;
  return {
    incomingThreadTs,
    messageTs,
    isThreadReply,
    replyToId,
    messageThreadId
  };
}
function resolveSlackThreadTargets(params) {
  const ctx = resolveSlackThreadContext(params);
  const { incomingThreadTs, messageTs, isThreadReply } = ctx;
  const replyThreadTs = isThreadReply ? incomingThreadTs : params.replyToMode === "all" ? messageTs : void 0;
  const statusThreadTs = replyThreadTs;
  return { replyThreadTs, statusThreadTs, isThreadReply };
}
export {
  resolveSlackThreadContext,
  resolveSlackThreadTargets
};
