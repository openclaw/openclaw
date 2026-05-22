import type { HomeView } from "@slack/types";
import type { SlackMonitorContext } from "../context.js";
export declare function buildSlackHomeView(): HomeView;
export declare function registerSlackHomeEvents(params: {
    ctx: SlackMonitorContext;
    trackEvent?: () => void;
}): void;
