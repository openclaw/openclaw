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
