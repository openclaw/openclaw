import { type DeliveryContext } from "../utils/delivery-context.js";
import type { SpawnSubagentMode } from "./subagent-spawn.js";
export declare function buildSubagentSystemPrompt(params: {
    requesterSessionKey?: string;
    requesterOrigin?: DeliveryContext;
    childSessionKey: string;
    label?: string;
    task?: string;
    /** Whether ACP-specific routing guidance should be included. Defaults to true. */
    acpEnabled?: boolean;
    /** Depth of the child being spawned (1 = sub-agent, 2 = sub-sub-agent). */
    childDepth?: number;
    /** Config value: max allowed spawn depth. */
    maxSpawnDepth?: number;
}): string;
export type SubagentRunOutcome = {
    status: "ok" | "error" | "timeout" | "unknown";
    error?: string;
};
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
    waitForCompletion?: boolean;
    startedAt?: number;
    endedAt?: number;
    label?: string;
    outcome?: SubagentRunOutcome;
    announceType?: SubagentAnnounceType;
    expectsCompletionMessage?: boolean;
    spawnMode?: SpawnSubagentMode;
    signal?: AbortSignal;
    bestEffortDeliver?: boolean;
}): Promise<boolean>;
