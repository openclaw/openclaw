import type { ReplyToMode } from "../config/types.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "./types.js";
export type SlackThreadContext = {
    incomingThreadTs?: string;
    messageTs?: string;
    isThreadReply: boolean;
    replyToId?: string;
    messageThreadId?: string;
};
export declare function resolveSlackThreadContext(params: {
    message: SlackMessageEvent | SlackAppMentionEvent;
    replyToMode: ReplyToMode;
}): SlackThreadContext;
/**
 * Resolves Slack thread targeting for replies and status indicators.
 *
 * @returns replyThreadTs - Thread timestamp for reply messages
 * @returns statusThreadTs - Thread timestamp for status indicators (typing, etc.)
 * @returns isThreadReply - true if this is a genuine user reply in a thread,
 *                          false if thread_ts comes from a bot status message (e.g. typing indicator)
 */
export declare function resolveSlackThreadTargets(params: {
    message: SlackMessageEvent | SlackAppMentionEvent;
    replyToMode: ReplyToMode;
}): {
    replyThreadTs: string | undefined;
    statusThreadTs: string | undefined;
    isThreadReply: boolean;
};
