import { describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isDurableQuestionRecoveryOwned } from "./main-session-question-recovery.js";

function entry(): InternalSessionEntry {
  return {
    sessionId: "original-session",
    updatedAt: 1,
    lifecycleRevision: "original-revision",
    restartRecoveryDeliveryRunId: "continuation-run",
    restartRecoveryDeliverySourceRunId: "continuation-run",
    durableQuestionOwners: [
      {
        questionId: "ask_original",
        sourceRunId: "asking-run",
        continuationRunId: "continuation-run",
        sessionId: "original-session",
        lifecycleRevision: "original-revision",
      },
    ],
  };
}

describe("native question recovery ownership", () => {
  it("retains exclusion after transcript and presentation receipt retention have elapsed", () => {
    expect(isDurableQuestionRecoveryOwned(entry())).toBe(true);
  });

  it("excludes the deliberately yielded asking run before the answer is admitted", () => {
    const asking = entry();
    asking.restartRecoveryDeliveryRunId = "asking-run";
    asking.restartRecoveryDeliverySourceRunId = "asking-run";
    delete asking.durableQuestionOwners![0]!.continuationRunId;
    expect(isDurableQuestionRecoveryOwned(asking)).toBe(true);
  });

  it.each([
    { sessionId: "replacement-session" },
    { lifecycleRevision: "replacement-revision" },
    {
      restartRecoveryDeliveryRunId: "new-user-turn",
      restartRecoveryDeliverySourceRunId: "new-user-turn",
    },
  ])(
    "does not suppress recovery belonging to a replacement or a later ordinary turn: %j",
    (replacement) => {
      expect(isDurableQuestionRecoveryOwned({ ...entry(), ...replacement })).toBe(false);
    },
  );
});
