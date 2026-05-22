import type { SlackMonitorContext } from "../context.js";
export declare function registerSlackChannelEvents(params: {
    ctx: SlackMonitorContext;
    trackEvent?: () => void;
}): void;
