import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { r as ReplyPayload } from "./reply-payload-DjPL5qa-.js";
//#region extensions/slack/src/interactive-replies.d.ts
declare function isSlackInteractiveRepliesEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean;
declare function compileSlackInteractiveReplies(payload: ReplyPayload): ReplyPayload;
declare function parseSlackOptionsLine(payload: ReplyPayload): ReplyPayload;
//#endregion
export { isSlackInteractiveRepliesEnabled as n, parseSlackOptionsLine as r, compileSlackInteractiveReplies as t };