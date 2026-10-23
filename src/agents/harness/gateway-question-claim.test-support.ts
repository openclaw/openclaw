import { expect } from "vitest";
import { claimPendingAgentQuestionAnswer } from "./gateway-question.js";

/** A denied submission probes admission without claiming input or sending an RPC. */
export async function expectPendingQuestionAnswerClaimable(
  sessionKey: string,
  claimable: boolean,
): Promise<void> {
  const refusal = new Error("question input availability probe");
  const answer = claimPendingAgentQuestionAnswer({
    sessionKey,
    text: "probe",
    authority: {
      kind: "run",
      assertCurrent() {
        throw refusal;
      },
    },
  });
  if (claimable) {
    await expect(answer).rejects.toBe(refusal);
  } else {
    await expect(answer).resolves.toBe(false);
  }
}
