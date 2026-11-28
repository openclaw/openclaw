import { describe, expect, it } from "vitest";
import { applyCommonWorkOperation } from "./common-work-adapter.js";
import {
  dispatchCommonWorkOperation,
  parseCommonWorkOperation,
} from "./common-work-gateway-schema.js";

const admitOperation = () => ({
  kind: "admit" as const,
  admission: {
    workId: "W-gateway",
    requestKey: "R-gateway",
    requestDigest: "sha256:request",
    goal: "A",
    objectiveDigest: "sha256:A",
    scope: ["gateway boundary"],
    acceptanceCriteria: ["new operations are reachable"],
    reportingLeadAgentId: "lead",
    ownerAgentId: "dev",
    lane: "common" as const,
    sourceSessionKey: "source",
    callbackSessionKey: "lead",
    userRoute: { channelId: "C1", threadId: "1.1", version: 1 },
    routeFamily: "common-work",
    routeSequence: 1,
  },
});

describe("common-work Gateway boundary", () => {
  it("requires every admitted objective-continuity fact and rejects unknown fields", () => {
    expect(parseCommonWorkOperation(admitOperation())).toEqual(admitOperation());
    for (const field of [
      "objectiveDigest",
      "scope",
      "acceptanceCriteria",
      "reportingLeadAgentId",
    ] as const) {
      const input = structuredClone(admitOperation()) as Record<string, unknown>;
      delete (input.admission as Record<string, unknown>)[field];
      expect(() => parseCommonWorkOperation(input)).toThrow();
    }
    expect(() =>
      parseCommonWorkOperation({
        ...admitOperation(),
        admission: { ...admitOperation().admission, unexpected: true },
      }),
    ).toThrow();
    expect(() => parseCommonWorkOperation({ ...admitOperation(), unexpected: true })).toThrow();
  });

  it("parses and dispatches correction, discovery approval, guarded attach, and helper return", async () => {
    let record = applyCommonWorkOperation(undefined, parseCommonWorkOperation(admitOperation()), 1);
    const unauthorizedCorrection = parseCommonWorkOperation({
      kind: "correct",
      expectedRevision: 1,
      goal: "A-prime",
      objectiveDigest: "sha256:A-prime",
      scope: ["different"],
      acceptanceCriteria: ["different"],
      reportingLeadAgentId: "helper",
      source: "agent_discovery",
    });
    expect(() => applyCommonWorkOperation(record, unauthorizedCorrection, 2)).toThrow(
      "only a receipt-backed user correction",
    );
    record = applyCommonWorkOperation(
      record,
      parseCommonWorkOperation({
        kind: "correct",
        expectedRevision: 1,
        goal: "A corrected",
        objectiveDigest: "sha256:A-corrected",
        scope: ["corrected scope"],
        acceptanceCriteria: ["corrected acceptance"],
        reportingLeadAgentId: "lead",
        source: "user_correction",
        correctionReceipt: "user:1",
      }),
      2,
    );
    record = applyCommonWorkOperation(
      record,
      parseCommonWorkOperation({
        kind: "classify_discovery",
        expectedRevision: 2,
        discoveryId: "A-prime",
        objective: "repair prerequisite",
        classification: "prerequisite_blocker",
        rationale: "A is blocked",
      }),
      3,
    );
    const guardedAttach = parseCommonWorkOperation({
      kind: "attach",
      expectedRevision: 3,
      executionId: "E-prime",
      generation: 1,
      sessionKey: "worker-prime",
      discoveredObjectiveId: "A-prime",
    });
    expect(guardedAttach).toMatchObject({ discoveredObjectiveId: "A-prime" });
    expect(() => applyCommonWorkOperation(record, guardedAttach, 4)).toThrow("without approval");
    record = applyCommonWorkOperation(
      record,
      parseCommonWorkOperation({
        kind: "approve_discovery",
        expectedRevision: 3,
        discoveryId: "A-prime",
        approvalReceipt: "approval:1",
      }),
      4,
    );
    record = applyCommonWorkOperation(
      record,
      parseCommonWorkOperation({ ...guardedAttach, expectedRevision: 4 }),
      5,
    );
    record = applyCommonWorkOperation(
      record,
      parseCommonWorkOperation({
        kind: "helper_return",
        expectedRevision: 5,
        helperAgentId: "helper",
        targetAgentId: "lead",
        receipt: "return:1",
      }),
      6,
    );
    expect(record).toMatchObject({
      goal: "A corrected",
      objectiveDigest: "sha256:A-corrected",
      execution: { executionId: "E-prime" },
      helperReturns: [{ agentId: "helper", receipt: "return:1" }],
    });
    const dispatched = await dispatchCommonWorkOperation(
      {
        kind: "helper_return",
        expectedRevision: 5,
        helperAgentId: "helper",
        targetAgentId: "lead",
        receipt: "return:gateway",
      },
      (operation) => operation,
    );
    expect(dispatched.kind).toBe("helper_return");
  });

  it("rejects unsupported classifications and invalid helper dispatch targets", () => {
    expect(() =>
      parseCommonWorkOperation({
        kind: "classify_discovery",
        expectedRevision: 1,
        discoveryId: "A-prime",
        objective: "repair",
        classification: "replace_A",
        rationale: "invalid",
      }),
    ).toThrow();
    const record = applyCommonWorkOperation(
      undefined,
      parseCommonWorkOperation(admitOperation()),
      1,
    );
    const wrongTarget = parseCommonWorkOperation({
      kind: "helper_return",
      expectedRevision: 1,
      helperAgentId: "helper",
      targetAgentId: "other",
      receipt: "return:bad",
    });
    expect(() => applyCommonWorkOperation(record, wrongTarget, 2)).toThrow(
      "must target the admitted reporting lead",
    );
  });
});
