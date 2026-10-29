import { buildRestartRecoveryExpectedState } from "../../../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";

/** Local outcome only: denied original authority must never deliver to another requester. */
export async function appendDeniedSubagentRecoveryNotice(params: {
  runId: string;
  reason?: string;
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  entry?: InternalSessionEntry;
  suppressSessionEffects: boolean;
  assertCurrent: () => void;
}): Promise<void> {
  const { entry } = params;
  if (
    !params.reason ||
    params.suppressSessionEffects ||
    !entry ||
    entry.status !== "interrupted" ||
    entry.lastRunId !== params.runId ||
    (entry.lifecycleRunId !== undefined && entry.lifecycleRunId !== params.runId) ||
    !params.agentId ||
    !params.storePath
  ) {
    return;
  }
  params.assertCurrent();
  const notice = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    expectedSessionId: entry.sessionId,
    expectedLifecycleRevision: entry.lifecycleRevision ?? null,
    expectedSessionState: buildRestartRecoveryExpectedState(entry),
    assertCurrent: params.assertCurrent,
    idempotencyKey: "subagent-restart:" + params.runId + ":interrupted",
    text:
      "This interrupted turn could not resume after the Gateway restarted: " +
      params.reason +
      ". Your session and transcript are preserved. Send a new authenticated message to continue.",
  });
  params.assertCurrent();
  if (!notice.ok) {
    throw new Error("Subagent recovery interruption notice was not saved: " + notice.reason);
  }
}
