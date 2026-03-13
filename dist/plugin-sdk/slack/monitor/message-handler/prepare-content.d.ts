import type { SlackMessageEvent } from "../../types.js";
import { type SlackMediaResult, type SlackThreadStarter } from "../media.js";
export type SlackResolvedMessageContent = {
    rawBody: string;
    effectiveDirectMedia: SlackMediaResult[] | null;
};
export declare function resolveSlackMessageContent(params: {
    message: SlackMessageEvent;
    isThreadReply: boolean;
    threadStarter: SlackThreadStarter | null;
    isBotMessage: boolean;
    botToken: string;
    mediaMaxBytes: number;
}): Promise<SlackResolvedMessageContent | null>;
