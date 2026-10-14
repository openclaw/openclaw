/**
 * A settle wake resumes the requester's own session, so admission needs the
 * requester incarnation binding even when no child requested a private
 * completion target: a visible child's terminal notice resumes the parent too.
 */
import { describe, expect, it } from "vitest";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import { resolvePrivateSettlePolicy } from "./subagent-announce.requester-settle-state.js";

const requester = { sessionId: "requester-session-1", lifecycleRevision: "rev-1" };
const state: RequesterSettleWakeState = { status: "pending", attemptCount: 0 };

function settleRow(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "child-run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    ...overrides,
  } as SubagentRunRecord;
}

describe("requester settle incarnation binding", () => {
  it("binds the requester incarnation when only visible children settled", () => {
    const { privateBinding } = resolvePrivateSettlePolicy([settleRow()], true, state, requester);
    expect(privateBinding).toMatchObject({
      completionRequesterSessionId: requester.sessionId,
      completionRequesterLifecycleRevision: requester.lifecycleRevision,
    });
    expect(privateBinding).not.toHaveProperty("completionTarget");
  });

  it("keeps the private completion target with the binding for parent-targeted children", () => {
    const { privateBinding } = resolvePrivateSettlePolicy(
      [settleRow({ completionTarget: "parent" })],
      true,
      state,
      requester,
    );
    expect(privateBinding).toMatchObject({
      completionTarget: "parent",
      completionRequesterSessionId: requester.sessionId,
    });
  });
});
