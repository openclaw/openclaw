import { describe, expect, it } from "vitest";
import { emptyLengthScenario, recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

describe("tool failure recovery guards", () => {
  it.each([false, true])(
    "does not resume a bodyless length stop after a tool failure (executionStarted=%s)",
    async (executionStarted) => {
      const { recovery, continueFromCurrentTranscript } = await recoverAfterTransportDrop({
        ...emptyLengthScenario,
        failedToolCallId: "call_2",
        lastToolError: { toolName: "exec", error: "command failed", executionStarted },
      });
      expect(recovery).toEqual({ action: "proceed" });
      expect(continueFromCurrentTranscript).not.toHaveBeenCalled();
    },
  );
});
