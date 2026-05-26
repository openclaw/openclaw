import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded.js";
export declare function runCliAgentWithLifecycle(params: {
    runId: string;
    provider: string;
    runParams: RunCliAgentParams;
    startedAt?: number;
    emitLifecycleStart?: boolean;
    emitLifecycleTerminal?: boolean;
    onAgentRunStart?: () => void;
    suppressAssistantBridge?: boolean;
    onAssistantText?: (text: string) => Promise<void>;
    onReasoningText?: (text: string) => Promise<void>;
    onErrorBeforeLifecycle?: (err: unknown) => Promise<void>;
    transformResult?: (result: EmbeddedPiRunResult) => EmbeddedPiRunResult;
}): Promise<EmbeddedPiRunResult>;
