import type { SlackMonitorContext } from "../context.js";
export declare function registerSlackPinEvents(params: {
    ctx: SlackMonitorContext;
    trackEvent?: () => void;
}): void;
