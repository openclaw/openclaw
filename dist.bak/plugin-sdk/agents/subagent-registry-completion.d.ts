import type { SubagentRunOutcome } from "./subagent-announce.js";
import { type SubagentLifecycleEndedOutcome, type SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function runOutcomesEqual(a: SubagentRunOutcome | undefined, b: SubagentRunOutcome | undefined): boolean;
export declare function resolveLifecycleOutcomeFromRunOutcome(outcome: SubagentRunOutcome | undefined): SubagentLifecycleEndedOutcome;
export declare function emitSubagentEndedHookOnce(params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    outcome?: SubagentLifecycleEndedOutcome;
    error?: string;
    inFlightRunIds: Set<string>;
    persist: () => void;
}): Promise<boolean>;
