import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import { detectToolCallLoop, recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";
export declare const beforeToolCallRuntime: {
    getDiagnosticSessionState: typeof getDiagnosticSessionState;
    logToolLoopAction: typeof logToolLoopAction;
    detectToolCallLoop: typeof detectToolCallLoop;
    recordToolCall: typeof recordToolCall;
    recordToolCallOutcome: typeof recordToolCallOutcome;
};
