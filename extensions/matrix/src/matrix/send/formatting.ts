import { getMatrixRuntime } from "../../runtime.js";
import { markdownToMatrixHtml } from "../format.js";
import {
  MsgType,
  RelationType,
  type MatrixFormattedContent,
  type MatrixMediaMsgType,
  type MatrixRelation,
  type MatrixReplyRelation,
  type MatrixTextContent,
  type MatrixThreadRelation,
} from "./types.js";

const getCore = () => getMatrixRuntime();

/**
 * Extract Matrix user IDs (@user:server) from message text for m.mentions (MSC3952).
 */
export function extractMatrixUserMentions(body: string): string[] {
  if (!body) return [];
  // Matrix user IDs: @localpart:server.tld
  const matches = body.match(/@[a-zA-Z0-9._=\-\/]+:[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

export function buildTextContent(body: string, relation?: MatrixRelation): MatrixTextContent {
  const content: MatrixTextContent = relation
    ? {
        msgtype: MsgType.Text,
        body,
        "m.relates_to": relation,
      }
    : {
        msgtype: MsgType.Text,
        body,
      };
  applyMatrixFormatting(content, body);
  applyMatrixMentions(content, body);
  return content;
}

export function applyMatrixFormatting(content: MatrixFormattedContent, body: string): void {
  const formatted = markdownToMatrixHtml(body ?? "");
  if (!formatted) {
    return;
  }
  content.format = "org.matrix.custom.html";
  content.formatted_body = formatted;
}

/**
 * Add m.mentions field to content based on Matrix user IDs found in the body.
 * Per MSC3952/Matrix spec v1.9, clients use m.mentions.user_ids for highlight notifications.
 */
export function applyMatrixMentions(content: Record<string, unknown>, body: string): void {
  const userIds = extractMatrixUserMentions(body);
  if (userIds.length > 0) {
    (content as Record<string, unknown>)["m.mentions"] = { user_ids: userIds };
  }
}
export function buildReplyRelation(replyToId?: string): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { "m.in_reply_to": { event_id: trimmed } };
}

export function buildThreadRelation(threadId: string, replyToId?: string): MatrixThreadRelation {
  const trimmed = threadId.trim();
  return {
    rel_type: RelationType.Thread,
    event_id: trimmed,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToId?.trim() || trimmed },
  };
}

export function resolveMatrixMsgType(contentType?: string, _fileName?: string): MatrixMediaMsgType {
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

export function resolveMatrixVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string;
  fileName?: string;
}): { useVoice: boolean } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isMatrixVoiceCompatibleAudio(opts)) {
    return { useVoice: true };
  }
  return { useVoice: false };
}

function isMatrixVoiceCompatibleAudio(opts: { contentType?: string; fileName?: string }): boolean {
  // Matrix currently shares the core voice compatibility policy.
  // Keep this wrapper as the seam if Matrix policy diverges later.
  return getCore().media.isVoiceCompatibleAudio({
    contentType: opts.contentType,
    fileName: opts.fileName,
  });
}
