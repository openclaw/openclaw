import type { SlackMonitorContext } from "../context.js";
export declare function registerSlackAssistantEvents(params: {
    ctx: SlackMonitorContext;
    /** Called on each inbound event to update liveness tracking. */
    trackEvent?: () => void;
}): void;
