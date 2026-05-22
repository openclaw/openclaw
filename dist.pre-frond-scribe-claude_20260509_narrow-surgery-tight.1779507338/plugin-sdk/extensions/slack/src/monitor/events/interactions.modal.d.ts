import type { SlackMonitorContext } from "../context.js";
import type { ModalInputSummary } from "./modal-input-summary.js";
type SlackModalInteractionKind = "view_submission" | "view_closed";
type SlackModalEventHandlerArgs = {
    ack: () => Promise<void>;
    body: unknown;
};
export type RegisterSlackModalHandler = (matcher: RegExp, handler: (args: SlackModalEventHandlerArgs) => Promise<void>) => void;
type SlackInteractionContextPrefix = "slack:interaction:view" | "slack:interaction:view-closed";
export declare function registerModalLifecycleHandler(params: {
    register: RegisterSlackModalHandler;
    matcher: RegExp;
    ctx: SlackMonitorContext;
    trackEvent?: () => void;
    interactionType: SlackModalInteractionKind;
    contextPrefix: SlackInteractionContextPrefix;
    summarizeViewState: (values: unknown) => ModalInputSummary[];
    formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void;
export {};
