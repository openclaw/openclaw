import type { CliBackendConfig } from "../../config/types.js";
import { type CliOutput, type CliStreamingDelta } from "../cli-output.js";
import type { PreparedCliRunContext } from "./types.js";
type ProcessSupervisor = ReturnType<typeof import("../../process/supervisor/index.js").getProcessSupervisor>;
type ClaudeLiveRunResult = {
    output: CliOutput;
};
export declare function resetClaudeLiveSessionsForTest(): void;
export declare function closeClaudeLiveSessionForContext(context: PreparedCliRunContext): Promise<void>;
export declare function shouldUseClaudeLiveSession(context: PreparedCliRunContext): boolean;
export declare function buildClaudeLiveArgs(params: {
    args: string[];
    backend: CliBackendConfig;
    systemPrompt: string;
    useResume: boolean;
}): string[];
export declare function runClaudeLiveSessionTurn(params: {
    context: PreparedCliRunContext;
    args: string[];
    env: Record<string, string>;
    prompt: string;
    useResume: boolean;
    noOutputTimeoutMs: number;
    getProcessSupervisor: () => ProcessSupervisor;
    onAssistantDelta: (delta: CliStreamingDelta) => void;
    cleanup: () => Promise<void>;
}): Promise<ClaudeLiveRunResult>;
export {};
