import { type DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type SubagentRunOutcome } from "./subagent-announce-output.js";
import { callGateway, getRuntimeConfig, resolveContinuationRuntimeConfig } from "./subagent-announce.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
type SubagentAnnounceDeps = {
    callGateway: typeof callGateway;
    getRuntimeConfig: typeof getRuntimeConfig;
    loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
    resolveContinuationRuntimeConfig: typeof resolveContinuationRuntimeConfig;
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
    /** When true, deliver completion as a silent system event instead of a
     *  visible channel message. Used for ambient enrichment (DELEGATE | silent). */
    silentAnnounce?: boolean;
    /** When true (with silentAnnounce), trigger a generation cycle on the parent
     *  session after enrichment delivery. Enables autonomous cognition loops
     *  (DELEGATE | silent-wake). */
    wakeOnReturn?: boolean;
}): Promise<boolean>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<SubagentAnnounceDeps>): void;
};
