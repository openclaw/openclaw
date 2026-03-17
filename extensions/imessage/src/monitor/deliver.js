import { chunkTextWithMode, resolveChunkMode } from "../../../../src/auto-reply/chunk.js";
import { loadConfig } from "../../../../src/config/config.js";
import { resolveMarkdownTableMode } from "../../../../src/config/markdown-tables.js";
import { convertMarkdownTables } from "../../../../src/markdown/tables.js";
import { sendMessageIMessage } from "../send.js";
import { sanitizeOutboundText } from "./sanitize-outbound.js";
async function deliverReplies(params) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
  const scope = `${accountId ?? ""}:${target}`;
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = sanitizeOutboundText(payload.text ?? "");
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      sentMessageCache?.remember(scope, { text });
      for (const chunk of chunkTextWithMode(text, textLimit, chunkMode)) {
        const sent = await sendMessageIMessage(target, chunk, {
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId
        });
        sentMessageCache?.remember(scope, { text: chunk, messageId: sent.messageId });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        const sent = await sendMessageIMessage(target, caption, {
          mediaUrl: url,
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId
        });
        sentMessageCache?.remember(scope, {
          text: caption || void 0,
          messageId: sent.messageId
        });
      }
    }
    runtime.log?.(`imessage: delivered reply to ${target}`);
  }
}
export {
  deliverReplies
};
