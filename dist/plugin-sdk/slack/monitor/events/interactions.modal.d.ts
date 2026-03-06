import type { SlackMonitorContext } from "../context.js";
export type ModalInputSummary = {
    blockId: string;
    actionId: string;
    actionType?: string;
    inputKind?: "text" | "number" | "email" | "url" | "rich_text";
    value?: string;
    selectedValues?: string[];
    selectedUsers?: string[];
    selectedChannels?: string[];
    selectedConversations?: string[];
    selectedLabels?: string[];
    selectedDate?: string;
    selectedTime?: string;
    selectedDateTime?: number;
    inputValue?: string;
    inputNumber?: number;
    inputEmail?: string;
    inputUrl?: string;
    richTextValue?: unknown;
    richTextPreview?: string;
};
export type SlackModalBody = {
    user?: {
        id?: string;
    };
    team?: {
        id?: string;
    };
    view?: {
        id?: string;
        callback_id?: string;
        private_metadata?: string;
        root_view_id?: string;
        previous_view_id?: string;
        external_id?: string;
        hash?: string;
        state?: {
            values?: unknown;
        };
    };
    is_cleared?: boolean;
};
export type SlackModalInteractionKind = "view_submission" | "view_closed";
export type SlackModalEventHandlerArgs = {
    ack: () => Promise<void>;
    body: unknown;
};
export type RegisterSlackModalHandler = (matcher: RegExp, handler: (args: SlackModalEventHandlerArgs) => Promise<void>) => void;
type SlackInteractionContextPrefix = "slack:interaction:view" | "slack:interaction:view-closed";
export declare function emitSlackModalLifecycleEvent(params: {
    ctx: SlackMonitorContext;
    body: SlackModalBody;
    interactionType: SlackModalInteractionKind;
    contextPrefix: SlackInteractionContextPrefix;
    summarizeViewState: (values: unknown) => ModalInputSummary[];
    formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void>;
export declare function registerModalLifecycleHandler(params: {
    register: RegisterSlackModalHandler;
    matcher: RegExp;
    ctx: SlackMonitorContext;
    interactionType: SlackModalInteractionKind;
    contextPrefix: SlackInteractionContextPrefix;
    summarizeViewState: (values: unknown) => ModalInputSummary[];
    formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void;
export {};
