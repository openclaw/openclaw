import { chunkMarkdownTextWithMode } from "../../../../src/auto-reply/chunk.js";
import { createReplyReferencePlanner } from "../../../../src/auto-reply/reply/reply-reference.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../../src/auto-reply/tokens.js";
import { parseSlackBlocksInput } from "../blocks-input.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { sendMessageSlack } from "../send.js";
function readSlackReplyBlocks(payload) {
  const slackData = payload.channelData?.slack;
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return void 0;
  }
  try {
    return parseSlackBlocksInput(slackData.blocks);
  } catch {
    return void 0;
  }
}
async function deliverReplies(params) {
  for (const payload of params.replies) {
    const inlineReplyToId = params.replyToMode === "off" ? void 0 : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    const slackBlocks = readSlackReplyBlocks(payload);
    if (!text && mediaList.length === 0 && !slackBlocks?.length) {
      continue;
    }
    if (mediaList.length === 0) {
      const trimmed = text.trim();
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        token: params.token,
        threadTs,
        accountId: params.accountId,
        ...slackBlocks?.length ? { blocks: slackBlocks } : {},
        ...params.identity ? { identity: params.identity } : {}
      });
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSlack(params.target, caption, {
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
          ...params.identity ? { identity: params.identity } : {}
        });
      }
    }
    params.runtime.log?.(`delivered reply to ${params.target}`);
  }
}
function resolveSlackThreadTs(params) {
  const planner = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasReplied,
    isThreadReply: params.isThreadReply
  });
  return planner.use();
}
function createSlackReplyReferencePlanner(params) {
  const effectiveIsThreadReply = params.isThreadReply ?? Boolean(params.incomingThreadTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied
  });
}
function createSlackReplyDeliveryPlan(params) {
  const replyReference = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasRepliedRef.value,
    isThreadReply: params.isThreadReply
  });
  return {
    nextThreadTs: () => replyReference.use(),
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    }
  };
}
async function deliverSlackSlashReplies(params) {
  const messages = [];
  const chunkLimit = Math.min(params.textLimit, 4e3);
  for (const payload of params.replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text = textRaw && !isSilentReplyText(textRaw, SILENT_REPLY_TOKEN) ? textRaw : void 0;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [text ?? "", ...mediaList.map((url) => url.trim()).filter(Boolean)].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks = chunkMode === "newline" ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode) : [combined];
    const chunks = markdownChunks.flatMap(
      (markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode })
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push(chunk);
    }
  }
  if (messages.length === 0) {
    return;
  }
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const text of messages) {
    await params.respond({ text, response_type: responseType });
  }
}
export {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  deliverSlackSlashReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs
};
