import { getMatrixRuntime } from "../../runtime.js";
import { markdownToMatrixHtml } from "../format.js";
import {
  MsgType,
  RelationType
} from "./types.js";
const getCore = () => getMatrixRuntime();
function buildTextContent(body, relation) {
  const content = relation ? {
    msgtype: MsgType.Text,
    body,
    "m.relates_to": relation
  } : {
    msgtype: MsgType.Text,
    body
  };
  applyMatrixFormatting(content, body);
  return content;
}
function applyMatrixFormatting(content, body) {
  const formatted = markdownToMatrixHtml(body ?? "");
  if (!formatted) {
    return;
  }
  content.format = "org.matrix.custom.html";
  content.formatted_body = formatted;
}
function buildReplyRelation(replyToId) {
  const trimmed = replyToId?.trim();
  if (!trimmed) {
    return void 0;
  }
  return { "m.in_reply_to": { event_id: trimmed } };
}
function buildThreadRelation(threadId, replyToId) {
  const trimmed = threadId.trim();
  return {
    rel_type: RelationType.Thread,
    event_id: trimmed,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToId?.trim() || trimmed }
  };
}
function resolveMatrixMsgType(contentType, _fileName) {
  const kind = getCore().media.mediaKindFromMime(contentType ?? "");
  switch (kind) {
    case "image":
      return MsgType.Image;
    case "audio":
      return MsgType.Audio;
    case "video":
      return MsgType.Video;
    default:
      return MsgType.File;
  }
}
function resolveMatrixVoiceDecision(opts) {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isMatrixVoiceCompatibleAudio(opts)) {
    return { useVoice: true };
  }
  return { useVoice: false };
}
function isMatrixVoiceCompatibleAudio(opts) {
  return getCore().media.isVoiceCompatibleAudio({
    contentType: opts.contentType,
    fileName: opts.fileName
  });
}
export {
  applyMatrixFormatting,
  buildReplyRelation,
  buildTextContent,
  buildThreadRelation,
  resolveMatrixMsgType,
  resolveMatrixVoiceDecision
};
