import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
export type SlackMessageHandler = (message: SlackMessageEvent, opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
}) => Promise<void>;
export declare function createSlackMessageHandler(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
}): SlackMessageHandler;
