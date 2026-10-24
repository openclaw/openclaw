import { vi } from "vitest";
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
