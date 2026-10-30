import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { runWithPreparedRunSourceScope } from "../admitted-run-context.js";
import type { RunCliAgentParams } from "./types.js";

/** Restore the selected source before preparing against its exact current-turn fence. */
export async function runWithCliPreparationSource<T>(
  params: RunCliAgentParams,
  prepare: () => Promise<T>,
): Promise<T> {
  if (!params.sessionManager && params.sessionTarget) {
    const { restoreSessionColdTranscript } =
      await import("../../config/sessions/session-cold-storage.js");
    await restoreSessionColdTranscript(params.sessionTarget);
  }
  // Fallbacks may already have admitted this user turn; recover only prior history.
  return runWithSessionTranscriptReadFence(
    params.sessionManager ? undefined : params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    () => runWithPreparedRunSourceScope(params, prepare),
  );
}

/** In-memory sessions own their source without borrowing durable transcript authority. */
export function normalizeCliPreparationSource(params: RunCliAgentParams): RunCliAgentParams {
  if (params.sessionManager) {
    // Caller-owned memory is authoritative even when empty. Correlation and native
    // bindings survive; borrowed durable paths, writers, and turn leases do not.
    return {
      ...params,
      sessionFile: `in-memory:${params.sessionManager.getSessionId()}`,
      sessionTarget: undefined,
      storePath: undefined,
      expectedLifecycleRevision: undefined,
      expectedWriterRunId: undefined,
      userTurnTranscriptRecorder: undefined,
      persistAssistantTranscript: undefined,
      prepareAssistantTranscriptMessage: undefined,
      contextEngineLogicalTurnLease: undefined,
      onContextEngineTurnCandidate: undefined,
    };
  }
  return params;
}
