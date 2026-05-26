import type { TuiStateAccess } from "./tui-types.js";
type EventHandlerChatLog = {
    startTool: (toolCallId: string, toolName: string, args: unknown) => void;
    updateToolResult: (toolCallId: string, result: unknown, options?: {
        partial?: boolean;
        isError?: boolean;
    }) => void;
    addSystem: (text: string) => void;
    updateAssistant: (text: string, runId: string) => void;
    finalizeAssistant: (text: string, runId: string) => void;
    dropAssistant: (runId: string) => void;
};
type EventHandlerTui = {
    requestRender: () => void;
};
type EventHandlerBtwPresenter = {
    showResult: (params: {
        question: string;
        text: string;
        isError?: boolean;
    }) => void;
    clear: () => void;
};
type EventHandlerContext = {
    chatLog: EventHandlerChatLog;
    btw: EventHandlerBtwPresenter;
    tui: EventHandlerTui;
    state: TuiStateAccess;
    setActivityStatus: (text: string) => void;
    refreshSessionInfo?: () => Promise<void>;
    loadHistory?: () => Promise<void>;
    noteLocalRunId?: (runId: string) => void;
    isLocalRunId?: (runId: string) => boolean;
    forgetLocalRunId?: (runId: string) => void;
    clearLocalRunIds?: () => void;
    isLocalBtwRunId?: (runId: string) => boolean;
    forgetLocalBtwRunId?: (runId: string) => void;
    clearLocalBtwRunIds?: () => void;
    /** Reset `streaming` after this much delta silence. Set to 0 to disable. */
    streamingWatchdogMs?: number;
    localMode?: boolean;
};
export declare function createEventHandlers(context: EventHandlerContext): {
    handleChatEvent: (payload: unknown) => void;
    handleAgentEvent: (payload: unknown) => void;
    handleBtwEvent: (payload: unknown) => void;
    pauseStreamingWatchdog: () => void;
    reconnectStreamingWatchdog: () => void;
    dispose: () => void;
};
export {};
