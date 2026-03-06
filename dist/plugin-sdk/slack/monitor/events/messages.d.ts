import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
export declare function registerSlackMessageEvents(params: {
    ctx: SlackMonitorContext;
    handleSlackMessage: SlackMessageHandler;
}): void;
