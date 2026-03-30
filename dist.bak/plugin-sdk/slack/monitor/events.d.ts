import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";
export declare function registerSlackMonitorEvents(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
    handleSlackMessage: SlackMessageHandler;
}): void;
