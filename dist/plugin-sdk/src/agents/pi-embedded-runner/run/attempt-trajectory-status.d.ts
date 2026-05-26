import { type AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
export type AttemptTrajectoryTerminalStatus = "success" | "error" | "interrupted";
export declare const NON_DELIVERABLE_TERMINAL_TURN_REASON = "non_deliverable_terminal_turn";
export type AttemptTrajectoryTerminal = {
    status: AttemptTrajectoryTerminalStatus;
    terminalError?: typeof NON_DELIVERABLE_TERMINAL_TURN_REASON;
};
export type ResolveAttemptTrajectoryTerminalParams = {
    promptError?: unknown;
    aborted: boolean;
    timedOut: boolean;
    assistantTexts: string[];
    toolMetas: Array<{
        toolName: string;
        meta?: string;
    }>;
    didSendViaMessagingTool: boolean;
    didSendDeterministicApprovalPrompt: boolean;
    messagingToolSentTexts: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: unknown[];
    successfulCronAdds: number;
    synthesizedPayloadCount: number;
    acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
    heartbeatToolResponse?: unknown;
    clientToolCalls?: Array<unknown>;
    yieldDetected?: boolean;
    lastToolError?: unknown;
    silentExpected?: boolean;
    emptyAssistantReplyIsSilent?: boolean;
    lastAssistantStopReason?: string;
};
export declare function resolveTerminalAssistantTexts(params: {
    assistantTexts: string[];
    lastAssistantStopReason?: string;
    lastAssistantVisibleText?: string;
}): string[];
export declare function resolveAttemptTrajectoryTerminal(params: ResolveAttemptTrajectoryTerminalParams): AttemptTrajectoryTerminal;
