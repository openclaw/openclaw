import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { SUBAGENT_ENDED_OUTCOME_ERROR, SUBAGENT_ENDED_OUTCOME_OK, SUBAGENT_ENDED_OUTCOME_TIMEOUT, SUBAGENT_TARGET_KIND_SUBAGENT, } from "./subagent-lifecycle-events.js";
export function runOutcomesEqual(a, b) {
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    if (a.status !== b.status) {
        return false;
    }
    if (a.status === "error" && b.status === "error") {
        return (a.error ?? "") === (b.error ?? "");
    }
    return true;
}
export function resolveLifecycleOutcomeFromRunOutcome(outcome) {
    if (outcome?.status === "error") {
        return SUBAGENT_ENDED_OUTCOME_ERROR;
    }
    if (outcome?.status === "timeout") {
        return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
    }
    return SUBAGENT_ENDED_OUTCOME_OK;
}
export async function emitSubagentEndedHookOnce(params) {
    const runId = params.entry.runId.trim();
    if (!runId) {
        return false;
    }
    if (params.entry.endedHookEmittedAt) {
        return false;
    }
    if (params.inFlightRunIds.has(runId)) {
        return false;
    }
    params.inFlightRunIds.add(runId);
    try {
        const hookRunner = getGlobalHookRunner();
        if (hookRunner?.hasHooks("subagent_ended")) {
            await hookRunner.runSubagentEnded({
                targetSessionKey: params.entry.childSessionKey,
                targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
                reason: params.reason,
                sendFarewell: params.sendFarewell,
                accountId: params.accountId,
                runId: params.entry.runId,
                endedAt: params.entry.endedAt,
                outcome: params.outcome,
                error: params.error,
            }, {
                runId: params.entry.runId,
                childSessionKey: params.entry.childSessionKey,
                requesterSessionKey: params.entry.requesterSessionKey,
            });
        }
        params.entry.endedHookEmittedAt = Date.now();
        params.persist();
        return true;
    }
    catch {
        return false;
    }
    finally {
        params.inFlightRunIds.delete(runId);
    }
}
