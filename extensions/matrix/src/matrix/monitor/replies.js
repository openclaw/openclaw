import { getMatrixRuntime } from "../../runtime.js";
import { sendMessageMatrix } from "../send.js";
async function deliverMatrixReplies(params) {
  const core = getMatrixRuntime();
  const cfg = core.config.loadConfig();
  const tableMode = params.tableMode ?? core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "matrix",
    accountId: params.accountId
  });
  const logVerbose = (message) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const chunkLimit = Math.min(params.textLimit, 4e3);
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "matrix", params.accountId);
  let hasReplied = false;
  for (const reply of params.replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.("matrix reply missing text/media");
      continue;
    }
    if (reply.text && isReasoningOnlyMessage(reply.text)) {
      logVerbose("matrix reply is reasoning-only; skipping");
      continue;
    }
    const replyToIdRaw = reply.replyToId?.trim();
    const replyToId = params.threadId || params.replyToMode === "off" ? void 0 : replyToIdRaw;
    const rawText = reply.text ?? "";
    const text = core.channel.text.convertMarkdownTables(rawText, tableMode);
    const mediaList = reply.mediaUrls?.length ? reply.mediaUrls : reply.mediaUrl ? [reply.mediaUrl] : [];
    const shouldIncludeReply = (id) => Boolean(id) && (params.replyToMode === "all" || !hasReplied);
    const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : void 0;
    if (mediaList.length === 0) {
      let sentTextChunk = false;
      for (const chunk of core.channel.text.chunkMarkdownTextWithMode(
        text,
        chunkLimit,
        chunkMode
      )) {
        const trimmed = chunk.trim();
        if (!trimmed) {
          continue;
        }
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          accountId: params.accountId
        });
        sentTextChunk = true;
      }
      if (replyToIdForReply && !hasReplied && sentTextChunk) {
        hasReplied = true;
      }
      continue;
    }
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : "";
      await sendMessageMatrix(params.roomId, caption, {
        client: params.client,
        mediaUrl,
        replyToId: replyToIdForReply,
        threadId: params.threadId,
        audioAsVoice: reply.audioAsVoice,
        accountId: params.accountId
      });
      first = false;
    }
    if (replyToIdForReply && !hasReplied) {
      hasReplied = true;
    }
  }
}
const REASONING_PREFIX = "Reasoning:\n";
const THINKING_TAG_RE = /^\s*<\s*(?:think(?:ing)?|thought|antthinking)\b/i;
function isReasoningOnlyMessage(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith(REASONING_PREFIX)) {
    return true;
  }
  if (THINKING_TAG_RE.test(trimmed)) {
    return true;
  }
  return false;
}
export {
  deliverMatrixReplies
};
