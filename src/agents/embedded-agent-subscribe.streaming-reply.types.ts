import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { StreamDirectiveCodePrefix } from "../utils/directive-tags.js";

/** Leaf contract shared by subscription state and the streaming implementation. */
export type StreamingReplyParams = {
  evtType: "text_delta" | "text_start" | "text_end";
  next: string;
  previousText: string;
  previousCleaned: string;
  visibleDelta: string;
  appendDelta: string | null;
  parsedStreamDirectives: ReplyDirectiveParseResult | null;
  previousAudioDirectiveCount: number;
  rawDirectiveSource?: string;
  rawProjectionText?: string;
  directiveCodePrefix?: StreamDirectiveCodePrefix;
};

export type StreamingReplyResult = {
  text: string;
  delta: string;
  replace: boolean;
  hasText: boolean;
  replyDirectives: ReplyDirectiveParseResult | null;
  audioDirectiveCount: number;
  directiveCodePrefix?: StreamDirectiveCodePrefix;
};

export type StreamingReplyResolver = (
  params: StreamingReplyParams & { rawDirectiveDelta?: string },
) => StreamingReplyResult;
