import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
export type SlackMessageHandler = (message: SlackMessageEvent, opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
}) => Promise<void>;
export declare class SlackRetryableInboundError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function createSlackMessageHandler(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
    /** Called on each inbound event to update liveness tracking. */
    trackEvent?: () => void;
}): SlackMessageHandler;
