import type { SlackMonitorContext } from "../context.js";
export declare function registerSlackReactionEvents(params: {
    ctx: SlackMonitorContext;
    trackEvent?: () => void;
}): void;
