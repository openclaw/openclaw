import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { type SlackMediaResult, type SlackThreadStarter } from "../media.js";
export type SlackThreadContextData = {
    threadStarterBody: string | undefined;
    threadHistoryBody: string | undefined;
    threadSessionPreviousTimestamp: number | undefined;
    threadLabel: string | undefined;
    threadStarterMedia: SlackMediaResult[] | null;
};
export declare function resolveSlackThreadContextData(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
    message: SlackMessageEvent;
    isThreadReply: boolean;
    threadTs: string | undefined;
    threadStarter: SlackThreadStarter | null;
    roomLabel: string;
    storePath: string;
    sessionKey: string;
    envelopeOptions: ReturnType<typeof import("../../../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
    effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData>;
