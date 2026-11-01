import { vi } from "vitest";
import { admitReplyTurn } from "../../../auto-reply/reply/reply-turn-admission.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import * as requesterTurnLiveness from "./subagent-requester-turn-liveness.js";

/** Reports the given requester turns as running in the session controller until ended. */
export function holdLiveRequesterTurns(...runIds: string[]) {
  const live = new Set(runIds);
  const spy = vi
    .spyOn(requesterTurnLiveness, "isClaimedByLiveRequesterTurn")
    .mockImplementation(
      (entry) =>
        entry.expectsCompletionMessage === true &&
        entry.requesterTurnRunId !== undefined &&
        live.has(entry.requesterTurnRunId),
    );
  return {
    end: (runId: string) => live.delete(runId),
    restore: () => spy.mockRestore(),
  };
}

export async function admitRequesterTurnForTest(sessionKey: string, storePath: string) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { sessionId: "requester-session", updatedAt: 1 },
  );
  const admitted = await admitReplyTurn({
    agentId: "main",
    sessionKey,
    sessionId: "requester-session",
    storePath,
    kind: "visible",
    resetTriggered: false,
  });
  if (admitted.status !== "owned") {
    throw new Error("Requester did not acquire its turn");
  }
  return admitted;
}
