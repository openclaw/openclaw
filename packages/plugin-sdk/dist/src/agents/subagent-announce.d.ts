import { type DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type SubagentRunOutcome } from "./subagent-announce-output.js";
import { callGateway, dispatchGatewayMethodInProcess, getRuntimeConfig } from "./subagent-announce.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
type SubagentAnnounceDeps = {
    callGateway: typeof callGateway;
    dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
    getRuntimeConfig: typeof getRuntimeConfig;
    loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};
declare function loadSubagentRegistryRuntime(): Promise<typeof import("./subagent-announce.registry.runtime.js")>;
export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";
export type SubagentAnnounceType = "subagent task" | "cron job";
export declare function runSubagentAnnounceFlow(params: {
    childSessionKey: string;
    childRunId: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    requesterDisplayKey: string;
    task: string;
    timeoutMs: number;
    cleanup: "delete" | "keep";
    roundOneReply?: string;
    /**
     * Fallback text preserved from the pre-wake run when a wake continuation
     * completes with NO_REPLY despite an earlier final summary already existing.
     */
    fallbackReply?: string;
    waitForCompletion?: boolean;
    startedAt?: number;
    endedAt?: number;
    label?: string;
    outcome?: SubagentRunOutcome;
    announceType?: SubagentAnnounceType;
    expectsCompletionMessage?: boolean;
    spawnMode?: SpawnSubagentMode;
    wakeOnDescendantSettle?: boolean;
    signal?: AbortSignal;
    bestEffortDeliver?: boolean;
    onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
}): Promise<boolean>;
export declare const testing: {
    setDepsForTest(overrides?: Partial<SubagentAnnounceDeps> & {
        callGateway?: typeof callGateway;
    }): void;
};
export { testing as __testing };
